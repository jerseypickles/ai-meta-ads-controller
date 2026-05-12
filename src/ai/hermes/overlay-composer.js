/**
 * Overlay Composer — toma foto base + agrega text overlay con offer + brand + dirección.
 *
 * Usa `sharp` (ya en deps). Compone la foto pro original + un strip inferior
 * con:
 *   - Offer headline (ej "FREE PICKLE ON YOUR 1ST VISIT")
 *   - Brand line ("JERSEY PICKLES NJ")
 *   - Address ("9 Romanelli Ave, South Hackensack NJ · Open daily")
 *
 * Output: PNG buffer listo para subir a Meta o renderear en dashboard.
 *
 * Diseño del strip (basado en el patrón Halal Guys + Big Dill Chamoy):
 *   ┌─────────────────────┐
 *   │                     │
 *   │   [foto pro]        │   ← imagen original sin tocar
 *   │                     │
 *   ├─────────────────────┤
 *   │ 🥒 FREE PICKLE...   │   ← strip negro/rojo con texto blanco
 *   │ JERSEY PICKLES NJ   │
 *   │ [address] · daily   │
 *   └─────────────────────┘
 */

const sharp = require('sharp');
const logger = require('../../utils/logger');

// Defaults (puede sobreescribirse en config)
const DEFAULT_STRIP_HEIGHT_RATIO = 0.25;        // 25% del alto total
const DEFAULT_STRIP_BG = '#1a1a1a';              // casi-negro
const DEFAULT_TEXT_COLOR = '#FFFFFF';
const DEFAULT_ACCENT_COLOR = '#D32F2F';          // rojo Halal Guys-style

/**
 * Escape XML for SVG text content (sharp usa SVG para overlays).
 */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Compone foto + overlay strip.
 *
 * @param {Buffer} baseImageBuffer - Foto base (de HermesPhotoAsset.image_base64 decoded)
 * @param {Object} overlayConfig
 * @param {string} overlayConfig.offer_text - Ej "FREE PICKLE ON YOUR 1ST VISIT"
 * @param {string} overlayConfig.brand_text - Ej "JERSEY PICKLES NJ"
 * @param {string} overlayConfig.address_text - Ej "9 Romanelli Ave · Open daily"
 * @param {string} [overlayConfig.bg_color] - Default #1a1a1a
 * @param {string} [overlayConfig.text_color] - Default #FFFFFF
 * @param {string} [overlayConfig.accent_color] - Default #D32F2F
 * @returns {Promise<Buffer>} PNG buffer
 */
async function composeAd(baseImageBuffer, overlayConfig) {
  const { offer_text, brand_text, address_text } = overlayConfig;
  const bgColor = overlayConfig.bg_color || DEFAULT_STRIP_BG;
  const textColor = overlayConfig.text_color || DEFAULT_TEXT_COLOR;
  const accentColor = overlayConfig.accent_color || DEFAULT_ACCENT_COLOR;

  if (!offer_text) throw new Error('overlayConfig.offer_text es requerido');

  // 1. Leer dimensiones de la foto base
  const baseMeta = await sharp(baseImageBuffer).metadata();
  const baseWidth = baseMeta.width;
  const baseHeight = baseMeta.height;

  if (!baseWidth || !baseHeight) {
    throw new Error('No se pudieron leer dimensiones de la imagen base');
  }

  // 2. Calcular altura del strip (ratio del alto base, mínimo 200px para legibilidad)
  const stripHeight = Math.max(200, Math.round(baseHeight * DEFAULT_STRIP_HEIGHT_RATIO));
  const finalHeight = baseHeight + stripHeight;

  // 3. Construir el SVG del strip — text scaling basado en width
  const titleFontSize = Math.round(baseWidth * 0.055);    // ~5.5% del width
  const brandFontSize = Math.round(baseWidth * 0.035);
  const addressFontSize = Math.round(baseWidth * 0.025);

  const padding = Math.round(baseWidth * 0.04);
  const titleY = Math.round(stripHeight * 0.35);
  const brandY = Math.round(stripHeight * 0.62);
  const addressY = Math.round(stripHeight * 0.85);

  const svgOverlay = `
    <svg width="${baseWidth}" height="${stripHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${baseWidth}" height="${stripHeight}" fill="${bgColor}"/>
      <rect x="0" y="0" width="${baseWidth}" height="4" fill="${accentColor}"/>
      <text
        x="${padding}"
        y="${titleY}"
        font-family="Arial Black, Helvetica, sans-serif"
        font-size="${titleFontSize}"
        font-weight="900"
        fill="${textColor}"
        dominant-baseline="middle"
      >${escapeXml(offer_text)}</text>
      ${brand_text ? `<text
        x="${padding}"
        y="${brandY}"
        font-family="Arial, Helvetica, sans-serif"
        font-size="${brandFontSize}"
        font-weight="700"
        fill="${accentColor}"
        dominant-baseline="middle"
      >${escapeXml(brand_text)}</text>` : ''}
      ${address_text ? `<text
        x="${padding}"
        y="${addressY}"
        font-family="Arial, Helvetica, sans-serif"
        font-size="${addressFontSize}"
        font-weight="400"
        fill="${textColor}"
        dominant-baseline="middle"
      >${escapeXml(address_text)}</text>` : ''}
    </svg>
  `;

  const svgBuffer = Buffer.from(svgOverlay);

  // 4. Componer: foto base + strip debajo
  // Estrategia — crear canvas con altura total, paste foto arriba, strip abajo
  const composed = await sharp({
    create: {
      width: baseWidth,
      height: finalHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    }
  })
    .composite([
      // Foto base arriba
      { input: baseImageBuffer, top: 0, left: 0 },
      // Strip con SVG overlay abajo
      { input: svgBuffer, top: baseHeight, left: 0 }
    ])
    .png()
    .toBuffer();

  logger.info(`[HERMES-COMPOSE] Composed ad ${baseWidth}x${finalHeight} (base ${baseWidth}x${baseHeight} + strip ${stripHeight}px) — offer: "${offer_text.slice(0, 40)}"`);

  return composed;
}

module.exports = { composeAd };
