/**
 * Overlay Composer — refactor 14-may-2026.
 *
 * Antes: añadía un strip negro DEBAJO de una foto pre-uploaded del banco,
 * con Arial Black. Ese flujo está deprecated (Hermes es 100% generativo
 * con gpt-image-2 desde 12-may-2026).
 *
 * Ahora: aplica typography editorial ENCIMA de la imagen de gpt-image-2.
 * gpt-image-2 genera food porn limpio con negative space upper 25% +
 * lower 15% reservado (forzado en el prompt). Este composer escribe en
 * esas zonas:
 *
 *   ┌──────────────────────────────┐
 *   │                              │ ← upper 25%: HEADLINE en font display
 *   │   "FREE CHAMOY PICKLE"       │   + SUBHEAD en font secundaria
 *   │                              │
 *   ├──────────────────────────────┤
 *   │                              │
 *   │   [FOOD PORN gpt-image-2]    │ ← middle 60%: imagen sin tocar
 *   │                              │
 *   │                              │
 *   ├──────────────────────────────┤
 *   │   BIG DILL CHAMOY →          │ ← lower 15%: TAGLINE + BRAND
 *   │   JERSEY PICKLES · NJ SHOP   │
 *   └──────────────────────────────┘
 *
 * 4 typography combos mapean a sets de fonts reales (via @fontsource — los
 * .woff2 se cargan en runtime, base64-encoded, embedded en SVG @font-face).
 * Si librsvg no logra cargar el @font-face por algún motivo, hay font-family
 * fallback chain con fonts del sistema.
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

// ═══════════════════════════════════════════════════════════════
// FONT LOADING — cargar woff2 desde @fontsource y cachear base64
// ═══════════════════════════════════════════════════════════════

const FONT_FILES = {
  anton:                'anton/files/anton-latin-400-normal.woff2',
  bebas_neue:           'bebas-neue/files/bebas-neue-latin-400-normal.woff2',
  dm_serif_display:     'dm-serif-display/files/dm-serif-display-latin-400-normal.woff2',
  dm_serif_italic:      'dm-serif-display/files/dm-serif-display-latin-400-italic.woff2',
  playfair_display:     'playfair-display/files/playfair-display-latin-400-normal.woff2',
  playfair_display_900: 'playfair-display/files/playfair-display-latin-900-normal.woff2',
  abril_fatface:        'abril-fatface/files/abril-fatface-latin-400-normal.woff2',
  oswald:               'oswald/files/oswald-latin-700-normal.woff2',
  inter:                'inter/files/inter-latin-400-normal.woff2',
  inter_900:            'inter/files/inter-latin-900-normal.woff2',
  special_elite:        'special-elite/files/special-elite-latin-400-normal.woff2'
};

const fontCache = new Map();

function loadFontBase64(fontKey) {
  if (fontCache.has(fontKey)) return fontCache.get(fontKey);

  const relPath = FONT_FILES[fontKey];
  if (!relPath) {
    logger.warn(`[HERMES-COMPOSE] Unknown font key: ${fontKey}`);
    fontCache.set(fontKey, null);
    return null;
  }

  try {
    const fontPath = path.join(__dirname, '../../../node_modules/@fontsource', relPath);
    const fontBuffer = fs.readFileSync(fontPath);
    const base64 = fontBuffer.toString('base64');
    fontCache.set(fontKey, base64);
    return base64;
  } catch (err) {
    logger.warn(`[HERMES-COMPOSE] Failed to load font ${fontKey}: ${err.message}`);
    fontCache.set(fontKey, null);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// TYPOGRAPHY COMBOS — mapeo de IDs (del rotator) a fonts reales
// ═══════════════════════════════════════════════════════════════

const TYPOGRAPHY_FONTS = {
  classic_editorial: {
    headline: { font_key: 'dm_serif_display', family: 'DM Serif Display', weight: 400, size_ratio: 0.085, letter_spacing: 0 },
    subhead:  { font_key: 'dm_serif_italic',  family: 'DM Serif Display', weight: 400, style: 'italic', size_ratio: 0.038, letter_spacing: 0 },
    tagline:  { font_key: 'bebas_neue',       family: 'Bebas Neue',       weight: 400, size_ratio: 0.045, letter_spacing: 2 },
    brand:    { font_key: 'inter',            family: 'Inter',            weight: 400, size_ratio: 0.022, letter_spacing: 3 }
  },
  bold_display: {
    headline: { font_key: 'anton',         family: 'Anton',  weight: 400, size_ratio: 0.105, letter_spacing: -1 },
    subhead:  { font_key: 'inter',         family: 'Inter',  weight: 400, size_ratio: 0.035, letter_spacing: 1 },
    tagline:  { font_key: 'anton',         family: 'Anton',  weight: 400, size_ratio: 0.048, letter_spacing: 1 },
    brand:    { font_key: 'inter_900',     family: 'Inter',  weight: 900, size_ratio: 0.022, letter_spacing: 3 }
  },
  retro_diner: {
    headline: { font_key: 'abril_fatface',   family: 'Abril Fatface',   weight: 400, size_ratio: 0.092, letter_spacing: 0 },
    subhead:  { font_key: 'dm_serif_italic', family: 'DM Serif Display',weight: 400, style: 'italic', size_ratio: 0.035, letter_spacing: 0 },
    tagline:  { font_key: 'bebas_neue',      family: 'Bebas Neue',      weight: 400, size_ratio: 0.045, letter_spacing: 2 },
    brand:    { font_key: 'special_elite',   family: 'Special Elite',   weight: 400, size_ratio: 0.022, letter_spacing: 2 }
  },
  punchy_modern: {
    headline: { font_key: 'anton',     family: 'Anton',  weight: 400, size_ratio: 0.110, letter_spacing: -2 },
    subhead:  { font_key: 'inter',     family: 'Inter',  weight: 400, size_ratio: 0.035, letter_spacing: 1 },
    tagline:  { font_key: 'oswald',    family: 'Oswald', weight: 700, size_ratio: 0.044, letter_spacing: 3 },
    brand:    { font_key: 'inter_900', family: 'Inter',  weight: 900, size_ratio: 0.022, letter_spacing: 3 }
  }
};

// ═══════════════════════════════════════════════════════════════
// COLOR PALETTES — por accent_color del variant
// ═══════════════════════════════════════════════════════════════

const ACCENT_COLOR_MAP = {
  'bright red':     '#E53935',
  'deep red':       '#C62828',
  'forest green':   '#2E7D32',
  'electric green': '#7CB342',
  'electric pink':  '#EC407A',
  'cream':          '#F5E6C3',
  'mustard':        '#F9A825',
  'burnt orange':   '#E65100'
};

function resolveAccentColor(accent) {
  if (!accent) return '#E53935';
  return ACCENT_COLOR_MAP[accent.toLowerCase()] || '#E53935';
}

// ═══════════════════════════════════════════════════════════════
// SVG BUILDING
// ═══════════════════════════════════════════════════════════════

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildFontFaceCss(combo) {
  const fonts = Object.values(combo);
  const seen = new Set();
  const declarations = [];

  for (const f of fonts) {
    if (seen.has(f.font_key)) continue;
    seen.add(f.font_key);

    const base64 = loadFontBase64(f.font_key);
    if (!base64) continue;

    const fontStyle = f.style || 'normal';
    declarations.push(`@font-face {
      font-family: '${f.family}';
      font-weight: ${f.weight};
      font-style: ${fontStyle};
      src: url(data:font/woff2;base64,${base64}) format('woff2');
    }`);
  }

  return declarations.join('\n');
}

function fontFamilyChain(family) {
  // Fallback chain por si librsvg no carga el @font-face
  const fallbacks = {
    'Anton':              `'Anton', 'Impact', 'Arial Black', 'Helvetica Neue', sans-serif`,
    'Bebas Neue':         `'Bebas Neue', 'Oswald', 'Impact', 'Arial Narrow', sans-serif`,
    'DM Serif Display':   `'DM Serif Display', 'Bodoni 72', 'Didot', 'Times New Roman', serif`,
    'Playfair Display':   `'Playfair Display', 'Bodoni 72', 'Didot', 'Times New Roman', serif`,
    'Abril Fatface':      `'Abril Fatface', 'Bodoni 72', 'Cooper Black', 'Georgia', serif`,
    'Oswald':             `'Oswald', 'Bebas Neue', 'Impact', 'Arial Narrow', sans-serif`,
    'Inter':              `'Inter', 'Helvetica Neue', 'Arial', sans-serif`,
    'Special Elite':      `'Special Elite', 'Courier New', 'Courier', monospace`
  };
  return fallbacks[family] || `'${family}', sans-serif`;
}

/**
 * Estimate ancho de un texto en píxeles dado un font_size.
 * Heurística aproximada — sin acceso a metrics reales del font, usamos
 * ratios típicos por estilo de family.
 */
function estimateTextWidth(text, family, fontSize) {
  const charWidthRatio =
    /Anton|Oswald|Bebas|Impact|Narrow|Condensed/i.test(family)  ? 0.50 :
    /Serif|Bodoni|Didot|Playfair|Abril|Cooper|Georgia/i.test(family) ? 0.62 :
    /Special Elite|Courier|Mono/i.test(family)                  ? 0.58 :
    /* default sans */                                            0.56;
  return text.length * fontSize * charWidthRatio;
}

/**
 * Word-wrap para que la línea más larga quepa en availableWidth.
 * Si una sola palabra excede el width, igual la deja (no se puede cortar).
 */
function wrapTextToWidth(text, family, fontSize, availableWidth) {
  if (estimateTextWidth(text, family, fontSize) <= availableWidth) return [text];

  const words = text.split(' ');
  if (words.length === 1) return [text];

  // Greedy line-fitting
  const lines = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = current + ' ' + words[i];
    if (estimateTextWidth(candidate, family, fontSize) <= availableWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);

  // Max 2 lines en upper zone — si quedan 3+, fuerza balance bisección
  if (lines.length > 2) {
    let bestIdx = 1;
    let bestDelta = Infinity;
    for (let i = 1; i < words.length; i++) {
      const first = words.slice(0, i).join(' ').length;
      const second = words.slice(i).join(' ').length;
      const delta = Math.abs(first - second);
      if (delta < bestDelta) { bestDelta = delta; bestIdx = i; }
    }
    return [
      words.slice(0, bestIdx).join(' '),
      words.slice(bestIdx).join(' ')
    ];
  }
  return lines;
}

/**
 * Auto-shrink: si después de wrap la línea más ancha sigue overflowing,
 * reduce font size proporcionalmente. Hasta 35% shrink max.
 */
function fitTextToWidth(text, family, baseFontSize, availableWidth) {
  let fontSize = baseFontSize;
  let lines = wrapTextToWidth(text, family, fontSize, availableWidth);

  // Calcula la línea más ancha
  let maxLineW = Math.max(...lines.map(l => estimateTextWidth(l, family, fontSize)));

  // Auto-shrink hasta que quepa o lleguemos al límite (65% del original)
  const minFontSize = Math.round(baseFontSize * 0.65);
  while (maxLineW > availableWidth && fontSize > minFontSize) {
    fontSize = Math.round(fontSize * 0.92);
    lines = wrapTextToWidth(text, family, fontSize, availableWidth);
    maxLineW = Math.max(...lines.map(l => estimateTextWidth(l, family, fontSize)));
  }

  return { lines, fontSize };
}

// ═══════════════════════════════════════════════════════════════
// TEXT LAYER BUILDER — SVG con typography para un canvas + zonas dadas
// ═══════════════════════════════════════════════════════════════

/**
 * Construye el SVG de texto completo (headline + subhead + tagline + brand
 * + scrims) para un canvas de dimensiones dadas y con las zonas verticales
 * pasadas. Compartido entre Feed y Story.
 *
 * @param {Object} o
 * @param {number} o.w - ancho del canvas
 * @param {number} o.h - alto del canvas
 * @param {Object} o.combo - typography combo (TYPOGRAPHY_FONTS[id])
 * @param {string} o.accentHex
 * @param {string} o.headline
 * @param {string} o.subhead
 * @param {string} o.tagline
 * @param {string} o.brand
 * @param {Object} o.zones - { headlineCenterY, taglineY, brandY } en px
 * @param {Object} o.scrim - { topH, botH } altura de los gradient scrims en px
 * @returns {string} SVG completo
 */
function buildTextLayer(o) {
  const { w, h, combo, accentHex, headline, subhead, tagline, brand, zones, scrim } = o;

  const padLeft = Math.round(w * 0.06);
  const availW = w - padLeft * 2;

  const fHeadlineBase = Math.round(w * combo.headline.size_ratio);
  const fSubhead = Math.round(w * combo.subhead.size_ratio);
  const fTaglineBase = Math.round(w * combo.tagline.size_ratio);
  const fBrand = Math.round(w * combo.brand.size_ratio);

  const headlineFit = fitTextToWidth((headline || '').toUpperCase(), combo.headline.family, fHeadlineBase, availW);
  const headlineLines = headlineFit.lines;
  const fHeadline = headlineFit.fontSize;
  const headlineLineH = Math.round(fHeadline * 0.98);

  const taglineFit = fitTextToWidth((tagline || '').toUpperCase(), combo.tagline.family, fTaglineBase, availW);
  const taglineLines = taglineFit.lines;
  const fTagline = taglineFit.fontSize;

  // Headline block centrado verticalmente en zones.headlineCenterY
  const totalHeadlineH = headlineLineH * headlineLines.length;
  const headlineFirstBaseline = zones.headlineCenterY - Math.round(totalHeadlineH / 2) + fHeadline;
  const subheadY = headlineFirstBaseline + (headlineLines.length - 1) * headlineLineH + Math.round(fSubhead * 1.15);

  const headlineSvg = headlineLines.map((line, i) => `
    <text x="${padLeft}" y="${headlineFirstBaseline + headlineLineH * i}"
          font-family="${fontFamilyChain(combo.headline.family)}"
          font-size="${fHeadline}" font-weight="${combo.headline.weight}"
          ${combo.headline.style ? `font-style="${combo.headline.style}"` : ''}
          letter-spacing="${combo.headline.letter_spacing || 0}"
          fill="white" stroke="rgba(0,0,0,0.6)" stroke-width="2" paint-order="stroke fill"
    >${escapeXml(line)}</text>`).join('');

  const subheadSvg = subhead ? `
    <text x="${padLeft}" y="${subheadY}"
          font-family="${fontFamilyChain(combo.subhead.family)}"
          font-size="${fSubhead}" font-weight="${combo.subhead.weight}"
          ${combo.subhead.style ? `font-style="${combo.subhead.style}"` : ''}
          fill="${accentHex}" stroke="rgba(0,0,0,0.5)" stroke-width="1.5" paint-order="stroke fill"
    >${escapeXml(subhead)}</text>` : '';

  const taglineSvg = tagline ? taglineLines.map((line, i) => `
    <text x="${padLeft}" y="${zones.taglineY + Math.round(fTagline * 0.98) * i}"
          font-family="${fontFamilyChain(combo.tagline.family)}"
          font-size="${fTagline}" font-weight="${combo.tagline.weight}"
          letter-spacing="${combo.tagline.letter_spacing || 0}"
          fill="${accentHex}" stroke="rgba(0,0,0,0.6)" stroke-width="2" paint-order="stroke fill"
    >${escapeXml(line)}</text>`).join('') : '';

  const brandSvg = `
    <text x="${padLeft}" y="${zones.brandY}"
          font-family="${fontFamilyChain(combo.brand.family)}"
          font-size="${fBrand}" font-weight="${combo.brand.weight}"
          letter-spacing="${combo.brand.letter_spacing || 0}"
          fill="rgba(245, 230, 195, 0.88)" stroke="rgba(0,0,0,0.5)" stroke-width="1" paint-order="stroke fill"
    >${escapeXml(brand)}</text>`;

  const fontFaceCss = buildFontFaceCss(combo);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style type="text/css"><![CDATA[
${fontFaceCss}
    ]]></style>
    <linearGradient id="topShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0.55)" />
      <stop offset="100%" stop-color="rgba(0,0,0,0)" />
    </linearGradient>
    <linearGradient id="botShade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0)" />
      <stop offset="100%" stop-color="rgba(0,0,0,0.65)" />
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${w}" height="${scrim.topH}" fill="url(#topShade)" />
  <rect x="0" y="${h - scrim.botH}" width="${w}" height="${scrim.botH}" fill="url(#botShade)" />
  ${headlineSvg}
  ${subheadSvg}
  ${taglineSvg}
  ${brandSvg}
</svg>`;
}

// ═══════════════════════════════════════════════════════════════
// FEED — 2:3 portrait (1024x1536). Texto en zonas upper/lower.
// ═══════════════════════════════════════════════════════════════

async function composeFeed(baseImageBuffer, cfg) {
  const meta = await sharp(baseImageBuffer).metadata();
  const w = meta.width;
  const h = meta.height;
  if (!w || !h) throw new Error('No se pudieron leer dimensiones de la imagen base');

  const svg = buildTextLayer({
    w, h,
    combo: cfg.combo,
    accentHex: cfg.accentHex,
    headline: cfg.headline,
    subhead: cfg.subhead,
    tagline: cfg.tagline,
    brand: cfg.brand,
    zones: {
      headlineCenterY: Math.round(h * 0.125),
      taglineY: Math.round(h * 0.915),
      brandY: Math.round(h * 0.96)
    },
    scrim: {
      topH: Math.round(h * 0.30),
      botH: Math.round(h * 0.20)
    }
  });

  return sharp(baseImageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

// ═══════════════════════════════════════════════════════════════
// STORY / REEL — 9:16 (1080x1920). Blurred-bg fill + safe zones IG.
// ═══════════════════════════════════════════════════════════════

const STORY_W = 1080;
const STORY_H = 1920;

async function composeStory(baseImageBuffer, cfg) {
  // 1. Background — la propia foto escalada a COVER 9:16, blur + oscurecida.
  //    Evita barras sólidas feas; da un fill premium estilo Instagram Story.
  const background = await sharp(baseImageBuffer)
    .resize(STORY_W, STORY_H, { fit: 'cover' })
    .blur(45)
    .modulate({ brightness: 0.45 })
    .toBuffer();

  // 2. Foreground — la foto 2:3 nítida a width completo (1080), centrada.
  const fg = await sharp(baseImageBuffer)
    .resize(STORY_W, null, { fit: 'inside' })
    .toBuffer();
  const fgMeta = await sharp(fg).metadata();
  const fgTop = Math.round((STORY_H - fgMeta.height) / 2);

  // 3. Text layer — safe zones de Instagram Story/Reel:
  //    top 14% reservado (perfil/close UI) · bottom 20% reservado (caption/
  //    reply bar/CTA/action rail). Todo el texto crítico vive entre 14%-80%.
  const svg = buildTextLayer({
    w: STORY_W, h: STORY_H,
    combo: cfg.combo,
    accentHex: cfg.accentHex,
    headline: cfg.headline,
    subhead: cfg.subhead,
    tagline: cfg.tagline,
    brand: cfg.brand,
    zones: {
      headlineCenterY: Math.round(STORY_H * 0.22),  // 22% — bajo el UI superior
      taglineY: Math.round(STORY_H * 0.74),          // 74% — sobre el UI inferior
      brandY: Math.round(STORY_H * 0.785)            // 78.5% — antes del 80% safe
    },
    scrim: {
      topH: Math.round(STORY_H * 0.32),
      botH: Math.round(STORY_H * 0.30)
    }
  });

  // 4. Componer: background blur → foto nítida centrada → text layer
  return sharp(background)
    .composite([
      { input: fg, top: fgTop, left: 0 },
      { input: Buffer.from(svg), top: 0, left: 0 }
    ])
    .png()
    .toBuffer();
}

// ═══════════════════════════════════════════════════════════════
// MAIN — composeAd dispatcher
// ═══════════════════════════════════════════════════════════════

/**
 * Aplica typography overlay sobre la imagen gpt-image-2.
 *
 * @param {Buffer} baseImageBuffer - PNG/JPEG buffer de gpt-image-2 (1024x1536 2:3)
 * @param {Object} overlayConfig
 * @param {string} overlayConfig.headline - "FREE CHAMOY PICKLE"
 * @param {string} overlayConfig.subhead - "on your 1st visit" (opcional)
 * @param {string} overlayConfig.tagline_with_arrow - "BIG DILL CHAMOY →"
 * @param {string} overlayConfig.brand_line - "JERSEY PICKLES · NJ SHOP"
 * @param {string} overlayConfig.typography_id - combo de TYPOGRAPHY_FONTS
 * @param {string} overlayConfig.accent_color - mapped via ACCENT_COLOR_MAP
 * @param {string} [overlayConfig.placement] - 'feed' (2:3, default) | 'story' (9:16)
 * @returns {Promise<Buffer>} PNG buffer
 */
async function composeAd(baseImageBuffer, overlayConfig) {
  const {
    headline = '',
    subhead = '',
    tagline_with_arrow = '',
    brand_line = 'JERSEY PICKLES · NJ SHOP',
    typography_id = 'bold_display',
    accent_color = 'bright red',
    placement = 'feed'
  } = overlayConfig;

  if (!headline) throw new Error('overlayConfig.headline es requerido');

  const cfg = {
    combo: TYPOGRAPHY_FONTS[typography_id] || TYPOGRAPHY_FONTS.bold_display,
    accentHex: resolveAccentColor(accent_color),
    headline,
    subhead,
    tagline: tagline_with_arrow,
    brand: brand_line
  };

  const composed = placement === 'story'
    ? await composeStory(baseImageBuffer, cfg)
    : await composeFeed(baseImageBuffer, cfg);

  const dims = placement === 'story' ? `${STORY_W}x${STORY_H}` : '2:3';
  logger.info(`[HERMES-COMPOSE] Composed ${placement} (${dims}) — typo:${typography_id} accent:${accent_color} headline:"${headline.slice(0, 30)}"`);

  return composed;
}

module.exports = {
  composeAd,
  TYPOGRAPHY_FONTS,
  ACCENT_COLOR_MAP,
  resolveAccentColor
};
