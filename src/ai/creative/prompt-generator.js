/**
 * Prompt Generator — Claude genera prompts optimizados para image-to-image
 * El producto real se pasa como imagen a los motores.
 * Claude genera el prompt que describe la escena/estilo ALREDEDOR del producto.
 *
 * Sistema dinamico: Claude analiza el producto y genera escenas contextualmente
 * relevantes donde el producto apareceria naturalmente en la vida real.
 * Las imagenes de referencia del banco guian la direccion creativa.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const sharp = require('sharp');
const config = require('../../../config');
const logger = require('../../utils/logger');

// Claude API limit is 5 MB for base64 images. We target 4 MB max to leave headroom.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB

/**
 * Comprime/redimensiona una imagen si excede MAX_IMAGE_BYTES.
 * Retorna { buffer, mediaType } listo para base64.
 */
async function compressImageForVision(filePath, originalMediaType) {
  const raw = fs.readFileSync(filePath);
  if (raw.length <= MAX_IMAGE_BYTES) {
    // Image is small enough, use as-is
    let mediaType = originalMediaType || 'image/jpeg';
    if (mediaType === 'image/webp') mediaType = 'image/png';
    return { buffer: raw, mediaType };
  }

  logger.info(`[PROMPT-GEN] Imagen ${filePath} excede limite (${(raw.length / 1024 / 1024).toFixed(1)} MB), comprimiendo...`);

  // Strategy: resize to max 1500px on longest side + JPEG quality 80
  let sharpInstance = sharp(raw)
    .resize(1500, 1500, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 });

  let compressed = await sharpInstance.toBuffer();

  // If still too large, reduce quality further
  if (compressed.length > MAX_IMAGE_BYTES) {
    compressed = await sharp(raw)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();
  }

  // Last resort: aggressive resize
  if (compressed.length > MAX_IMAGE_BYTES) {
    compressed = await sharp(raw)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 50 })
      .toBuffer();
  }

  logger.info(`[PROMPT-GEN] Imagen comprimida: ${(raw.length / 1024 / 1024).toFixed(1)} MB → ${(compressed.length / 1024 / 1024).toFixed(1)} MB`);
  return { buffer: compressed, mediaType: 'image/jpeg' };
}

const SYSTEM_PROMPT = `You are a world-class creative director and prompt engineer specializing in Meta Ads (Facebook/Instagram) for ecommerce. You write prompts for OpenAI's gpt-image-1.5 image editing model.

THE SETUP: The user will give you a style, and optionally REFERENCE IMAGES of the actual product. You will generate 3 rich, detailed, creative prompts — each with a UNIQUE scene that makes sense for this specific product. OpenAI receives the REAL product photo + your prompt. Your prompt describes the WORLD AROUND the product. Each prompt will be generated twice (1:1 feed and 9:16 stories) — so write format-agnostic scenes. Do NOT mention specific aspect ratios in your prompts.

═══════════════════════════════════════════════════════════════
 HOW THE ENGINE WORKS
═══════════════════════════════════════════════════════════════

OpenAI gpt-image-1.5 receives:
1. The real product photograph (as input image)
2. Your text prompt

The engine EDITS the image — it changes the background and surroundings while keeping the product. Your prompt should describe:
- The SCENE around the product (surfaces, objects, textures, clutter, props)
- The LIGHTING of the environment (source, direction, quality, color temperature)
- The CAMERA used (device, lens, distance, angle, quality)
- TEXT OVERLAYS to render on the image (handwritten text, arrows, meme text)
- The overall MOOD and aesthetic

DO NOT describe the product itself. Never mention brand names, label text, packaging colors, or product features. The product is already in the photo — you only describe what surrounds it.

═══════════════════════════════════════════════════════════════
 PRODUCT-AWARE SCENE GENERATION — THE CORE PRINCIPLE
═══════════════════════════════════════════════════════════════

This is the most important part. You MUST analyze the product image carefully and generate scenes where THIS SPECIFIC product would NATURALLY appear in real life.

Think about:
- What IS this product? (food, beverage, cosmetic, tool, clothing, etc.)
- HOW do people USE or CONSUME it? (eating, cooking with, applying, wearing, etc.)
- WHERE would it naturally be found? (kitchen counter, dining table, BBQ, picnic, etc.)
- WHEN do people interact with it? (breakfast, late night snack, party, routine, etc.)
- WHO uses it? (home cook, snacker, health enthusiast, etc.)
- What OTHER ITEMS would naturally be NEXT TO IT in that moment?

For food products like pickles, olives, sauces, condiments:
- Scenes with the food being USED: nachos with jar open, tacos being assembled, charcuterie board, burger being built
- Scenes of CONSUMPTION moments: late night snacking, game day spread, BBQ table, picnic
- Scenes of DISCOVERY: grocery haul on counter, fridge door open, pantry shelf
- The surrounding props should be REAL FOOD and REAL KITCHEN ITEMS that make sense together

NEVER put a product in a scene that makes no logical sense (pickles on a gym bench, food jar on a bathroom counter, condiment on a car dashboard). Every scene must pass the "would this actually happen?" test.

═══════════════════════════════════════════════════════════════
 REFERENCE IMAGES — ANALYZE CAREFULLY
═══════════════════════════════════════════════════════════════

If the user provides reference images of the product, you MUST carefully analyze them to understand:
- What the product actually IS (shape, size, packaging type, colors)
- What kind of environments this product would REALISTICALLY appear in
- The scale of the product — scenes must make sense for the product's real size
- What surfaces/contexts are NATURAL for this specific product

Use this visual understanding to TAILOR every scene.

═══════════════════════════════════════════════════════════════
 TOP PERFORMERS — LEARN FROM WINNERS
═══════════════════════════════════════════════════════════════

If the user provides TOP PERFORMER images (our best-selling ads by ROAS), these are PROVEN winners. Study them carefully:
- What MOOD/ENERGY makes them work? (casual, messy, bright, cozy, etc.)
- What kind of SCENE/ENVIRONMENT resonates? (kitchen, car, desk, etc.)
- How is the LIGHTING? (natural, warm, harsh fluorescent, etc.)
- What TEXT OVERLAYS work? (placement, style, language, energy)
- What COMPOSITION feels authentic? (angle, distance, clutter level)

Use these insights to INSPIRE your new prompts. Don't copy — EVOLVE. Create fresh scenes that capture the same winning energy while exploring new territory.

═══════════════════════════════════════════════════════════════
 PRODUCT PRESERVATION (include in every prompt)
═══════════════════════════════════════════════════════════════

Start every prompt with this opener + preservation instruction:

"Edit this product photograph. Change ONLY the background and surroundings. [FORMAT]. The product from the reference photo must remain EXACTLY as it appears — same shape, same label, same colors, same text, same proportions. Do NOT re-render, redraw, or generate a 3D version of the product. Keep it as the original flat photographic element. Do NOT add lighting effects (rim light, glow, highlights) ON the product. Do NOT alter, warp, or reshape the packaging. The product should look physically placed in the new scene."

Then go directly into your creative scene description. Keep preservation concise but firm.

═══════════════════════════════════════════════════════════════
 TEXT OVERLAYS — CRITICAL FOR PERFORMANCE
═══════════════════════════════════════════════════════════════

Text overlays are one of the MOST IMPORTANT elements for ad performance. OpenAI can render text well — USE THIS.

For ORGANIC style (REQUIRED — this is what makes organic ads convert):
- Add 2-4 pieces of handwritten/scribbled text in different spots around the image
- Use casual, messy, "real person" handwriting style — NOT clean fonts
- Draw arrows pointing toward (but NOT touching/overlapping) the product
- Add circle/underline doodles around key text
- Text must be in ENGLISH — use TikTok/internet language:
  * Hook text: "POV: you found the hack" / "wait... this actually works??" / "ok hear me out" / "I'm not even kidding rn"
  * Reaction text: "obsessed ngl" / "3am impulse buy" / "my toxic trait" / "no one asked but HERE" / "lowkey the best thing ever"
  * Call-out text: "THIS >>>" / "game changer fr" / "why didn't I know sooner" / "don't sleep on this"
  * Arrow labels: "the good stuff →" / "literally changed my life" / "trust me bro"
- PLACEMENT: corners, margins, above/below/beside the product — NEVER on top of the product label
- VARIETY: each of your 3 prompts must have DIFFERENT text content. Don't repeat phrases across prompts.
- Be SPECIFIC in the prompt about what text to write and where to place it. Example: "In the upper-left corner, messy handwritten text in black marker reads 'ok hear me out...' with an arrow curving down toward the product. In the bottom-right, scribbled in red pen: 'obsessed ngl' with a circle doodle around it."
- Make text RELEVANT to the product and scene — if it's food, use food-related hooks like "the secret ingredient" or "put this on everything"

For UGC style:
- Optional but recommended: 1-2 casual reaction texts
- "just arrived!!" / "omg finally" / "the unboxing energy is real" / "ok this is cute"
- Placed naturally in the scene, handwritten or typed-looking

For MEME style (REQUIRED):
- Bold white Impact font text with black outline
- TOP TEXT: the setup/situation (e.g. "WHEN YOUR FRIEND SAYS THEY DON'T NEED THIS")
- BOTTOM TEXT: the punchline (e.g. "THEY LYING")
- Classic meme format — text in top and bottom margins, NOT on the product
- Make the humor RELEVANT to the product category

For POLISHED style:
- NO text overlays. Clean, premium, editorial. Let the product speak.

═══════════════════════════════════════════════════════════════
 STYLES — CREATIVE DIRECTION
═══════════════════════════════════════════════════════════════

## organic (Casual, Authentic — Phone Photography)
Must look like a REAL PERSON took this with their phone in a REAL MOMENT. NOT an agency. NOT polished. NOT staged.
SCENE: Invent a scene that makes sense for THIS PRODUCT. Be hyper-specific about the physical objects, mess, and real-life items around the product. The scene should feel like it ALREADY EXISTED — the person just set the product down in the middle of their actual life and snapped a photo. Include incidental details that make it feel LIVED-IN and ORGANIC.
LIGHTING: Uneven, natural, from a REAL source in the environment. Fluorescent, window light, lamp — whatever matches the location. Imperfect. Include artifacts of real phone photography: slight overexposure near windows, warm color casts from incandescent bulbs, mixed color temperatures.
CAMERA: "Photograph taken with iPhone 14, native camera app, auto settings, no editing. Slightly off-center, casual framing, phone held at a natural angle as if the person stopped what they were doing to take a quick photo. Mild lens distortion, real sensor noise, JPEG compression artifacts visible. Slight motion blur from hand-holding. No color grading, no filters, no post-processing."
TEXT: REQUIRED. 2-4 handwritten text elements + arrows + doodles. See TEXT OVERLAYS section above.
MOOD: casual, relatable, unpolished, organic, real-life moment, "took this with my phone real quick", anti-ad energy.

## ugc (User Generated Content)
Feels like someone sharing a genuine moment with their product on social media — NOT a scripted influencer post.
SCENE: First-person POV — camera looking down at the product. Hands visible reaching toward (but not covering) the product. Invent a setting that makes sense for this product — where would someone naturally show it off to their friends? The environment should feel REAL and LIVED-IN with small imperfections: a smudge on a surface, slightly wrinkled fabric, a stray crumb.
LIGHTING: Natural, warm, slightly overexposed highlights from windows. The lighting should feel ACCIDENTAL, not set up — like the person just happened to be in good light.
CAMERA: "iPhone selfie-angle, vertical framing, slightly blown-out highlights, warm color cast, casual autofocus, JPEG quality. The camera angle is natural — held slightly above and looking down, as someone would actually hold their phone to snap a photo of something on a table."
TEXT: 1-2 casual reaction texts recommended. See TEXT OVERLAYS section.
MOOD: excited, genuine, organic moment, "just had to share this", real-person energy.

## polished (Premium Product Photography)
High-end editorial product photography — clean, premium, intentional.
SCENE: Invent a premium surface and minimal props that complement the product. Think food photography for food products, editorial for lifestyle products. Minimalist, intentional composition. Single product centered, props placed around (not overlapping). Should feel like a real photograph taken in a styled setting.
LIGHTING: Professional, directional, controlled but NATURAL-looking. Soft shadows, clean highlights.
CAMERA: "Shot on full-frame DSLR, 85mm f/1.4 lens, shallow depth of field, background softly blurred. Sharp focus on the product. Natural color science, correct white balance."
TEXT: NONE. Clean. Let the product and scene speak.
MOOD: premium, clean, trustworthy, aspirational, editorial.

## meme (Meme Format)
Viral, funny, shareable. The humor should be RELEVANT to the product.
SCENE: Invent an absurd/funny scenario where the product appears in an unexpected but humorous context. The humor should connect to what the product IS or DOES. Must still look like a REAL photograph — not a digital collage or CGI.
CAMERA: "Low quality JPEG, internet-compressed, possibly screenshot quality, casual framing. Looks like someone took a quick photo of something funny and shared it."
TEXT: REQUIRED. Bold Impact font meme text. Top + bottom. See TEXT OVERLAYS section.
MOOD: funny, shareable, absurd, viral, internet culture.

═══════════════════════════════════════════════════════════════
 PROMPT STRUCTURE (for each of the 3 prompts)
═══════════════════════════════════════════════════════════════

Write each prompt as a flowing, detailed paragraph (not a numbered list). Follow this order:

1. OPENER: "Edit this product photograph. Change ONLY the background and surroundings. [style] photograph."
2. PRESERVATION: The concise product preservation instruction (see above).
3. CAMERA: Exact device, lens, settings, angle, distance.
4. SCENE: Rich, detailed description of the physical environment. Name specific objects, textures, materials, colors, mess, props. 5-8 specific items/details minimum. Paint the picture. ALL SCENE ELEMENTS MUST MAKE SENSE FOR THIS PRODUCT.
5. LIGHTING: Specific source, direction, quality, color temperature. Describe how light falls on the SCENE (not on the product).
6. TEXT OVERLAYS: Exact text content in English, handwriting style, color, size, and precise placement. Be very specific — "In the upper-left corner, handwritten in black marker: 'ok but why is this so good??' with a wobbly arrow pointing right toward the product."
7. MOOD: 3-5 mood keywords.
8. CLOSING: "The product must remain exactly as in the reference photo — same label, same shape, same everything. Only change the background and surroundings."

IMPORTANT: Do NOT include any format/aspect ratio instructions (like "Square 1:1" or "Vertical 9:16") in your prompts. The system adds the format automatically when generating each image.

═══════════════════════════════════════════════════════════════
 OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "prompts": [
    {
      "prompt": "The complete detailed prompt in English. Minimum 150 words. Rich, vivid, specific. The text overlay section should be the most detailed part for organic and meme styles. Do NOT mention any aspect ratio or format.",
      "scene_label": "Short label in Spanish, 2-5 words (e.g. 'Nachos nocturnos', 'Mesa de tacos', 'Picnic veraniego')"
    }
  ],
  "style_rationale": "Brief explanation in Spanish of why these scenes work for this product and how they connect to real usage moments",
  "suggested_headline": "Ad headline in Spanish",
  "suggested_body": "Ad body text in Spanish (1-2 lines)"
}

You MUST generate exactly 3 prompts with 3 DIFFERENT scenes. Each scene must be contextually relevant to the product and completely different from the others — different location, different moment, different energy.`;

/**
 * Genera un prompt optimizado para image-to-image.
 * @param {Object} options
 * @param {string} options.style - Estilo deseado (organic, polished, ugc, meme)
 * @param {string} options.format - Formato (feed, stories)
 * @param {string} options.userInstruction - Instruccion libre del usuario
 * @param {string} options.productName - Nombre del producto seleccionado
 * @param {string} options.productDescription - Descripcion/notas del producto
 * @param {Array} options.styleData - Data de rendimiento por estilo del banco
 * @param {Array} options.referenceAssets - Assets de referencia para contexto de estilo
 * @param {Array} options.topPerformers - Best-performing creatives of same style (visual inspiration)
 * @param {Array} options.scenePerformance - Scene labels ranked by ROAS performance
 */
async function generatePrompt({ style, format, userInstruction, productName = '', productDescription = '', styleData = [], referenceAssets = [], productImagePath = '', topPerformers = [], scenePerformance = [] }) {
  const apiKey = config.claude.apiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY no configurada');

  const client = new Anthropic({ apiKey });

  // Normalize legacy style name
  const normalizedStyle = style === 'ugly-ad' ? 'organic' : style;

  // Build style performance context
  let styleContext = '';
  if (styleData.length > 0) {
    const lines = styleData.map(s =>
      `- Estilo "${s.style}": ${s.count} creativos, ROAS promedio ${s.avg_roas?.toFixed(1) || 'N/A'}x, CTR promedio ${s.avg_ctr?.toFixed(2) || 'N/A'}%`
    ).join('\n');
    styleContext = `\nSTYLE PERFORMANCE DATA (from creative bank):\n${lines}\nUse this data to understand what's working.\n`;
  }

  // Build scene performance context — which scenes have proven results
  let scenePerformanceContext = '';
  const validScenePerformance = (scenePerformance || []).filter(s => s.scene_label && typeof s.scene_label === 'string');
  if (validScenePerformance.length > 0) {
    const sceneLines = validScenePerformance.map(s =>
      `- "${s.scene_label}": ROAS ${s.avg_roas?.toFixed(1) || 'N/A'}x, CTR ${s.avg_ctr?.toFixed(2) || 'N/A'}%, used ${s.total_used}x across ${s.count} creatives`
    ).join('\n');
    scenePerformanceContext = `\nSCENE PERFORMANCE DATA (proven scene types by ROAS — use as creative direction):\n${sceneLines}\nThese scene types have PROVEN results. Create scenes with similar vibes, moods, and contexts. Don't copy exactly — use them as INSPIRATION for what kind of settings resonate with the audience.\n`;
  }

  // Build reference assets context (text metadata)
  let referenceContext = '';
  if (referenceAssets.length > 0) {
    const refLines = referenceAssets.map(r =>
      `- "${r.headline || r.original_name}" (style: ${r.style || 'other'})${r.notes ? ` — Notes: ${r.notes}` : ''}${r.tags?.length ? ` — Tags: ${r.tags.join(', ')}` : ''}${r.avg_roas > 0 ? ` — ROAS: ${r.avg_roas.toFixed(1)}x` : ''}`
    ).join('\n');
    referenceContext = `\nREFERENCE ASSETS (creative direction from the bank — use these as style/mood guidance):\n${refLines}\nThese references define the aesthetic direction. Align your scene and mood to match this creative vision.\n`;
  }

  // Build reference image vision blocks (send actual product images to Claude)
  // Images are compressed if they exceed the 5 MB Claude API limit
  const referenceImageBlocks = [];
  if (referenceAssets.length > 0) {
    for (const ref of referenceAssets) {
      if (ref.file_path && fs.existsSync(ref.file_path) && ref.media_type === 'image') {
        try {
          const { buffer, mediaType } = await compressImageForVision(ref.file_path, ref.file_type || 'image/jpeg');
          const base64 = buffer.toString('base64');
          referenceImageBlocks.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          });
          referenceImageBlocks.push({
            type: 'text',
            text: `[Reference image: "${ref.product_name || ref.headline || ref.original_name}" — ${ref.style || 'other'} style]`
          });
        } catch (e) {
          logger.warn(`[PROMPT-GEN] No se pudo leer imagen de referencia ${ref._id}: ${e.message}`);
        }
      }
    }
  }

  // Build top performer image blocks — best-performing creatives as visual inspiration
  const topPerformerImageBlocks = [];
  if (topPerformers.length > 0) {
    for (const perf of topPerformers) {
      if (perf.file_path && fs.existsSync(perf.file_path) && perf.media_type === 'image') {
        try {
          const { buffer, mediaType } = await compressImageForVision(perf.file_path, perf.file_type || 'image/jpeg');
          const base64 = buffer.toString('base64');
          topPerformerImageBlocks.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          });
          topPerformerImageBlocks.push({
            type: 'text',
            text: `[TOP PERFORMER — ROAS: ${perf.avg_roas?.toFixed(1) || '?'}x, CTR: ${perf.avg_ctr?.toFixed(2) || '?'}%, Scene: "${perf.scene_label || 'unknown'}", Style: ${perf.style}. This ad WORKS — use it as visual INSPIRATION for scene mood, lighting, and composition. Do NOT copy it exactly — create NEW scenes inspired by what makes this one successful.]`
          });
        } catch (e) {
          logger.warn(`[PROMPT-GEN] No se pudo leer top performer ${perf._id}: ${e.message}`);
        }
      }
    }
    if (topPerformerImageBlocks.length > 0) {
      logger.info(`[PROMPT-GEN] Incluyendo ${topPerformerImageBlocks.filter(b => b.type === 'image').length} top performers como inspiracion visual`);
    }
  }

  // Also include the selected product image if available
  if (productImagePath && fs.existsSync(productImagePath)) {
    try {
      const ext = productImagePath.split('.').pop().toLowerCase();
      const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/png', gif: 'image/gif' };
      const origMediaType = mimeMap[ext] || 'image/jpeg';
      const { buffer, mediaType } = await compressImageForVision(productImagePath, origMediaType);
      const base64 = buffer.toString('base64');
      referenceImageBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64 }
      });
      referenceImageBlocks.push({
        type: 'text',
        text: `[THIS IS THE PRODUCT IMAGE that OpenAI will receive. Analyze it carefully — understand the product's shape, size, packaging, and colors. Your scenes MUST make sense for THIS SPECIFIC product. Think about where, how, and when people actually use/consume/display this product in real life.]`
      });
    } catch (e) {
      logger.warn(`[PROMPT-GEN] No se pudo leer imagen del producto: ${e.message}`);
    }
  }

  // Build product context
  let productContext = '';
  if (productName || productDescription) {
    productContext = `\nPRODUCT CONTEXT:`;
    if (productName) productContext += `\n- Name: ${productName}`;
    if (productDescription) productContext += `\n- Description: ${productDescription}`;
    productContext += `\nUse this context to create scenes that make sense for THIS specific product. Think about where, how, and when people use/consume/display this product in real life.\n`;
  }

  const NUM_SCENES = 3;

  const userMessage = `Generate 3 image-editing prompts for Meta Ads. OpenAI gpt-image-1.5 will receive the real product photo + your prompt. Each prompt will be rendered in BOTH 1:1 (feed) and 9:16 (stories) formats, so write format-agnostic scene descriptions.

PRODUCT: ${productName || 'Product from the creative bank'}
STYLE: ${normalizedStyle}
${productContext}${styleContext}${scenePerformanceContext}${referenceContext}
${userInstruction ? `USER INSTRUCTION (apply creatively to ALL prompts): ${userInstruction}` : ''}

CRITICAL — PRODUCT-CONTEXTUAL SCENES:
- You MUST invent 3 completely different scenes where this product NATURALLY appears in real life
- Analyze the product image: What IS it? How is it USED? Where would someone ENCOUNTER it?
- Every scene must pass the "would this actually happen?" test
- For food products: show the food being USED (with nachos, on tacos, in a recipe, as a snack, on a charcuterie board, etc.)
- The props, surfaces, and surrounding objects must make LOGICAL SENSE with this product
- Each scene should capture a different MOMENT: different location, different time of day, different activity
- Do NOT use generic/random scenes — make every scene SPECIFIC to this product

REQUIREMENTS:
- Generate exactly 3 prompts, each with a UNIQUE contextually-relevant scene
- Each prompt must be a rich, flowing paragraph — NOT a bulleted list
- Follow the prompt structure from your instructions (opener → preservation → camera → scene → lighting → text overlays → mood → closing)
- NEVER describe the product itself — only the world around it
- Do NOT mention any aspect ratio or format (1:1, 9:16, square, vertical, etc.) — the system adds this automatically
- Each scene must feel completely different from the others

TEXT OVERLAYS — MAKE THEM GREAT:
${normalizedStyle === 'organic' ? `- REQUIRED in every prompt. This is what makes organic-style ads convert on Meta.
- Include 2-4 handwritten text elements per prompt with EXACT text content, style, color, and placement
- Each prompt MUST have UNIQUE text — different phrases, different placement, different personality
- Use casual English internet/TikTok language — relatable, funny, unhinged, real
- Make text RELEVANT to the product — food products get food-related hooks
- Add arrows, doodles, circles, underlines — the messier the better
- Be VERY SPECIFIC: "In the upper-left corner, handwritten in thick black marker: 'ok hear me out...' with a wobbly arrow curving toward the product. Bottom-right, scribbled in red pen: 'obsessed ngl' circled twice."
- NEVER place text on top of the product label` : normalizedStyle === 'meme' ? `- REQUIRED. Bold white Impact font with black outline.
- TOP TEXT: setup/situation. BOTTOM TEXT: punchline.
- Make it genuinely funny and shareable. Each prompt needs unique meme text.
- Make the humor RELEVANT to this specific product.
- Classic meme layout — text in margins, not on the product.` : normalizedStyle === 'ugc' ? `- Recommended: 1-2 casual reaction texts per prompt ("just arrived!!", "omg finally", "this is it")
- Handwritten or typed-looking, placed naturally in the scene` : `- No text for polished style. Clean and editorial.`}

SCENE RICHNESS:
- Name at least 5-8 specific physical objects/details in each scene
- Include textures, materials, colors, imperfections
- The more specific and vivid, the better OpenAI will execute it
- ALL objects must be things that would ACTUALLY be near this product in real life

${normalizedStyle === 'organic' || normalizedStyle === 'ugc' ? `AUTHENTICITY:
- Every scene MUST feel like a real moment someone captured on their phone
- The product should look CASUALLY PLACED, not arranged — as if the person set it down naturally
- Include real-life imperfections: crumbs, water rings, slightly wrinkled fabric, condensation
- Lighting should come from real environmental sources — windows, lamps, overhead lights
- NEVER create scenes that feel staged, too clean, or like stock photography
- Think: "what would this product actually look like in someone's REAL life right now?"
` : ''}${referenceImageBlocks.length > 0 ? `PRODUCT IMAGES PROVIDED:
- I have attached reference images of the actual product above
- ANALYZE these images carefully: understand the product shape, size, packaging, colors, and type
- TAILOR every scene to make sense for THIS SPECIFIC product
- Choose props, surfaces, and contexts where this product would NATURALLY appear in real life
- The scenes should feel like organic moments where someone who OWNS this product lives their daily life
` : ''}${topPerformerImageBlocks.length > 0 ? `TOP PERFORMING ADS — VISUAL INSPIRATION:
- I have attached images of our BEST-PERFORMING ads (highest ROAS) above
- These ads ACTUALLY WORK — they drive real sales and engagement
- Study the mood, lighting, composition, scene type, and energy of these winning ads
- Use them as CREATIVE INSPIRATION — create NEW scenes that capture a similar VIBE
- Do NOT copy them directly — innovate on what makes them successful
- Pay attention to text overlay placement and style if present
` : ''}
Remember: respond with ONLY valid JSON, no markdown fences. 3 prompts total. Do NOT include any format/aspect ratio in the prompts.`;

  const totalImages = referenceImageBlocks.filter(b => b.type === 'image').length + topPerformerImageBlocks.filter(b => b.type === 'image').length;
  logger.info(`[PROMPT-GEN] Generando ${NUM_SCENES} prompts con Claude (estilo: ${normalizedStyle}, dual format 1:1+9:16, imagenes ref: ${referenceImageBlocks.filter(b => b.type === 'image').length}, top performers: ${topPerformerImageBlocks.filter(b => b.type === 'image').length})`);
  const startTime = Date.now();

  // Build message content — include reference images + top performers as vision if available
  const allImageBlocks = [...referenceImageBlocks, ...topPerformerImageBlocks];
  const messageContent = allImageBlocks.length > 0
    ? [...allImageBlocks, { type: 'text', text: userMessage }]
    : userMessage;

  const response = await client.messages.create({
    model: config.claude.model,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: messageContent }]
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`[PROMPT-GEN] Claude respondio en ${elapsed}s`);

  const text = response.content[0]?.text || '';

  let parsed;
  try {
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    logger.error(`[PROMPT-GEN] Error parseando respuesta de Claude: ${e.message}`);
    logger.error(`[PROMPT-GEN] Raw (primeros 500 chars): ${text.substring(0, 500)}`);
    // Fallback: try to use text as a single prompt
    parsed = {
      prompts: [{ prompt: text.substring(0, 2000), scene_label: 'Escena generada' }],
      style_rationale: 'Prompt generado sin formato JSON',
      suggested_headline: '',
      suggested_body: ''
    };
  }

  // Normalize: support both old single-prompt and new multi-prompt format
  let prompts = parsed.prompts || [];
  if (prompts.length === 0 && parsed.prompt) {
    prompts = [{ prompt: parsed.prompt, scene_label: 'Escena 1' }];
  }

  logger.info(`[PROMPT-GEN] ${prompts.length} prompts generados`);

  return {
    prompts,
    style_rationale: parsed.style_rationale,
    suggested_headline: parsed.suggested_headline || '',
    suggested_body: parsed.suggested_body || '',
    style: normalizedStyle,
    format,
    generation_time_s: parseFloat(elapsed)
  };
}

module.exports = { generatePrompt };
