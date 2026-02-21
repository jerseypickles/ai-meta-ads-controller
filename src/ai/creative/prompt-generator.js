/**
 * Prompt Generator — Claude genera prompts optimizados para image-to-image
 * El producto real se pasa como imagen a los motores.
 * Claude genera el prompt que describe la escena/estilo ALREDEDOR del producto.
 *
 * Sistema dinamico: el contexto de marca/producto se inyecta en runtime,
 * las imagenes de referencia del banco guian la direccion creativa.
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

// ═══════════════════════════════════════════════════════════════
// SCENE POOLS — rotacion dinamica para variedad en cada generacion
// ═══════════════════════════════════════════════════════════════

const UGLY_AD_SCENES = [
  // KITCHEN
  { location: 'kitchen', surface: 'messy kitchen counter with crumbs, a damp sponge, and a half-peeled banana', lighting: 'afternoon sunlight coming through kitchen window from the left, creating uneven warm patches and hard shadows on the counter', angle: '30cm above, looking down at 45 degrees, phone slightly tilted left' },
  { location: 'kitchen', surface: 'kitchen table after breakfast — cereal box tipped over, milk ring stain, crumpled napkin, a spoon with dried yogurt', lighting: 'morning light from east-facing window, slightly overexposed on the right side', angle: '25cm above, slightly off-center to the right, casual tilt' },
  { location: 'kitchen', surface: 'stovetop area with a greasy burner grate, a used wooden spatula, splatter marks on the backsplash tile', lighting: 'harsh overhead kitchen light, yellowish fluorescent cast, unflattering', angle: '40cm back, angled view showing stovetop edge' },
  { location: 'kitchen', surface: 'open dishwasher door used as makeshift shelf, wet dishes visible inside, water droplets on the counter beside it', lighting: 'dim under-cabinet LED strips, cool white tone, shadows underneath', angle: '35cm away, eye-level with the counter, slight upward tilt' },
  { location: 'kitchen', surface: 'refrigerator shelf next to leftover containers, a half-empty ketchup bottle, and a wilting bag of salad', lighting: 'cold refrigerator interior light from above, blue-white cast', angle: 'straight on, phone held inside the fridge door' },

  // BATHROOM
  { location: 'bathroom', surface: 'bathroom counter next to a toothbrush in a glass, squeeze tube of toothpaste with cap off, water spots on mirror visible behind', lighting: 'overhead fluorescent bathroom light, slightly greenish cast, unflattering', angle: '20cm above, looking down at 50 degrees, centered' },
  { location: 'bathroom', surface: 'edge of the bathtub with a damp towel draped over, shampoo bottles clustered in corner, soap scum visible', lighting: 'single warm bulb above the mirror reflecting off wet tile surfaces', angle: '30cm back, side angle showing tub edge and wall' },

  // BEDROOM
  { location: 'bedroom', surface: 'unmade bed with wrinkled sheets, phone charger cable tangled, a half-empty glass of water on the nightstand', lighting: 'early morning light filtering through blinds, creating striped shadows across the bed', angle: '40cm above nightstand, looking down casually, slight motion blur' },
  { location: 'bedroom', surface: 'nightstand cluttered with AirPods case, crumpled receipt, lip balm, phone face-down, alarm clock showing 2:47 AM', lighting: 'dim warm bedside lamp casting a small pool of light, rest of room dark', angle: '25cm above, phone held at sleepy angle, slightly blurry' },
  { location: 'bedroom', surface: 'messy dresser top with loose change, tangled earbuds, a stack of folded laundry that is falling over', lighting: 'window light from behind camera, flat and even, slightly overcast', angle: '35cm back, straight-on view of dresser surface' },

  // CAR
  { location: 'car', surface: 'car cup holder with old receipts stuffed around it, aux cable dangling, crumbs in seat crevice', lighting: 'harsh midday sun through windshield, creating strong highlights and deep shadows inside the car', angle: 'passenger seat POV, looking down at center console, dashboard visible' },
  { location: 'car', surface: 'car dashboard with sunglasses, parking ticket, phone mount with cracked screen phone visible', lighting: 'golden hour sun streaming through driver side window at low angle', angle: 'driver seat, one hand on steering wheel visible in frame edge' },

  // OFFICE / DESK
  { location: 'office', surface: 'cluttered office desk with sticky notes, open laptop showing spreadsheet, cold coffee mug with stain ring', lighting: 'overhead office panel light, flat and slightly blue, fluorescent flicker feel', angle: '30cm above desk, looking down at keyboard and product, off-center' },
  { location: 'office', surface: 'work-from-home desk with dual monitors showing Zoom call, mechanical keyboard, energy drink can, cable mess', lighting: 'screen glow mixed with window light from behind, creating mixed color temperature', angle: 'selfie-angle from seated position, screens blurred in background' },

  // LIVING ROOM / COUCH
  { location: 'couch', surface: 'couch armrest with TV remote, a throw blanket bunched up, popcorn kernels scattered on cushion', lighting: 'TV screen glow casting bluish light in otherwise dim room', angle: '20cm above armrest, looking down, casual one-handed shot' },
  { location: 'couch', surface: 'coffee table with ring stains, a magazine, scattered snack wrappers, and the TV remote', lighting: 'late afternoon sun from a side window, warm and directional, dust particles visible', angle: '30cm above, angled shot from couch perspective' },

  // OUTDOOR CASUAL
  { location: 'outdoor', surface: 'park bench with peeling paint, dry leaves, a half-eaten sandwich in wax paper beside product', lighting: 'dappled sunlight through tree canopy, uneven bright spots and deep shade', angle: '25cm above bench, looking down, outdoor breeze motion blur feel' },
  { location: 'outdoor', surface: 'plastic patio table at a BBQ with paper plates, red solo cups, ketchup squeeze bottle, napkin blowing away', lighting: 'bright overcast sky, flat even outdoor light, no harsh shadows', angle: '35cm back, eye-level with table, backyard fence blurry behind' },
  { location: 'outdoor', surface: 'beach towel on sand with flip flops, sunscreen bottle, a sandy phone, sunglasses', lighting: 'intense midday beach sun, everything slightly overexposed, heat haze shimmer', angle: '40cm above, looking down at towel, toes visible at edge' },

  // GYM / FITNESS
  { location: 'gym', surface: 'gym bench with a sweaty towel, water bottle, wireless earbuds case, chalk dust', lighting: 'harsh overhead gym fluorescents, bright and clinical, no warmth', angle: '30cm above bench, looking down, gym floor and weights blurry behind' },
  { location: 'gym', surface: 'locker room bench with open gym bag, deodorant, car keys, crumpled protein bar wrapper', lighting: 'mixed fluorescent and natural light from high windows, slightly dim', angle: '25cm above, casual phone snap while changing' },

  // LAUNDRY / UTILITY
  { location: 'laundry', surface: 'top of washing machine with dryer sheets box, loose socks, a wrinkled shirt waiting to be ironed', lighting: 'overhead utility room bulb, harsh single shadow, stark and unflattering', angle: '30cm above, looking down at washing machine top' },

  // DORM / COLLEGE
  { location: 'dorm', surface: 'dorm desk covered in textbooks, highlighters with caps off, empty ramen cup, laptop charger tangle', lighting: 'desk lamp creating harsh pool of warm light, rest of tiny room dim', angle: '20cm above desk, looking down, exhausted-student-at-3am vibe' },
  { location: 'dorm', surface: 'mini fridge top in dorm room with instant noodle cup, Red Bull can, sticky notes, a plushie', lighting: 'overhead dorm ceiling light, flat and institutional', angle: '30cm back, standing over mini fridge, tapestry on wall behind blurred' },

  // GROCERY / SHOPPING
  { location: 'store', surface: 'shopping cart child seat area with other grocery items visible — bread bag, avocados, a coupon flyer', lighting: 'supermarket fluorescent ceiling lights, bright blue-white, commercial feel but casual snap', angle: '25cm above cart, looking down, other shoppers blurred in aisle behind' },

  // PATIO / BALCONY
  { location: 'balcony', surface: 'small apartment balcony table with a half-smoked citronella candle, a book face-down open, dead plant in pot', lighting: 'sunset golden light from the west, warm orange cast, long shadows', angle: '30cm above table, city skyline or buildings blurred behind' },

  // BATHROOM FLOOR
  { location: 'bathroom', surface: 'bathroom floor tile next to the tub, bath mat slightly askew, rubber duck, a wet footprint visible', lighting: 'warm overhead bathroom vanity light, steam haze softening everything slightly', angle: '50cm above, phone pointing straight down at floor' },

  // TAILGATE / TRUCK
  { location: 'tailgate', surface: 'truck tailgate with a cooler, fishing tackle box, a crushed beer can, dirt and leaf debris', lighting: 'late afternoon outdoor light, partly cloudy, soft but directional from behind', angle: '40cm back from tailgate, looking slightly down, trees in background' },

  // CAMPING
  { location: 'camping', surface: 'fold-out camping table with a propane stove, enamel mug, crumpled trail mix bag, a dirty map', lighting: 'early morning overcast sky light, foggy and cool, muted colors', angle: '30cm above table, looking down, tent edge visible in frame corner' },
];

const UGC_SCENES = [
  { surface: 'just-unboxed on bed with shipping box open, tissue paper and packing peanuts scattered, phone box-cutter visible', lighting: 'natural window light from the left, slightly warm, unboxing energy', pov: 'first-person looking down at bed, hands reaching toward product' },
  { surface: 'kitchen island with a cutting board, fresh ingredients spread out as if about to cook, recipe on iPad visible', lighting: 'bright kitchen window backlight, slightly overexposed highlights', pov: 'first-person POV standing at counter, hands visible at frame edges' },
  { surface: 'vanity table with mirror reflection visible, makeup brushes, jewelry tray, fairy lights in background', lighting: 'warm ring light glow reflecting in mirror, soft and flattering', pov: 'sitting at vanity, product placed centered, mirror shows room behind' },
  { surface: 'outdoor cafe table with espresso cup, croissant on a plate, sunglasses, a tote bag on chair', lighting: 'morning outdoor cafe light, dappled through an umbrella, warm European vibe', pov: 'sitting across small table, hand reaching for product, street blurred' },
  { surface: 'yoga mat on living room floor with water bottle, resistance bands, a towel, TV showing workout video', lighting: 'natural window light mixed with TV glow, morning energy', pov: 'sitting cross-legged on mat, looking down at product between knees' },
  { surface: 'picnic blanket on grass with charcuterie board, wine glass, wildflowers, a straw hat', lighting: 'golden hour outdoor light, warm and directional, lens flare hint', pov: 'sitting on blanket, knees visible, product placed on blanket in front' },
  { surface: 'home office desk mid-workday, notebook open with handwritten notes, pen, coffee mug half-full, plant', lighting: 'window light from behind laptop screen, mixed with screen glow', pov: 'first-person at desk, laptop keyboard visible, product next to mouse' },
  { surface: 'bathroom shelf during skincare routine, other products lined up, cotton pads, a small mirror', lighting: 'bright bathroom vanity lights, clean white, morning routine feel', pov: 'standing at sink, mirror edge visible, hands reaching for product' },
];

const POLISHED_SCENES = [
  { surface: 'white Carrara marble countertop with subtle grey veining, a single eucalyptus sprig as prop', lighting: 'soft directional light from upper-left, gentle shadow to right, clean and editorial' },
  { surface: 'light ash wood table with fine grain texture, a linen napkin folded beside, single dried lavender stem', lighting: 'soft window light from right, creating a gentle gradient across the wood surface' },
  { surface: 'matte black slate surface with subtle texture, a single copper spoon as prop, dark and moody', lighting: 'dramatic side light from left, deep shadows, cinematic product photography feel' },
  { surface: 'raw concrete pedestal with industrial texture, minimalist white background behind, architectural vibe', lighting: 'overhead softbox creating even illumination on surface, subtle shadow underneath product' },
  { surface: 'terrazzo surface with colorful chips, a small ceramic dish with sea salt as prop, Mediterranean feel', lighting: 'warm afternoon light from behind, slight backlight halo on surface, not on product' },
  { surface: 'dark walnut cutting board on white quartz countertop, a small bowl of fresh herbs, chef-kitchen premium', lighting: 'cool-toned overhead light balanced with warm side fill, professional food-photography setup' },
  { surface: 'pale pink linen fabric draped as background, single peony flower laid beside, feminine editorial', lighting: 'soft diffused window light, no harsh shadows, airy and bright' },
  { surface: 'aged brass tray on weathered oak table, a small vintage glass, antique-modern contrast', lighting: 'warm directional light from upper-right, creating rich shadows and depth in metal textures' },
];

const MEME_SCENES = [
  { context: 'product sitting on the Iron Throne from a low-budget cosplay setup (cardboard and aluminum foil throne), medieval tapestry background', humor: 'epic/mundane contrast' },
  { context: 'product on a witness stand in a courtroom sketch-style setting, judge gavel visible, dramatic legal drama', humor: 'product on trial for being too good' },
  { context: 'product strapped into a rollercoaster seat, blurred theme park background, arms-up energy', humor: 'wild ride metaphor' },
  { context: 'product sitting in a tiny shopping cart being pushed by a cat paw, pet store aisle background', humor: 'cat shopping, internet culture' },
  { context: 'product on a red carpet with paparazzi camera flashes, velvet rope barrier, Hollywood premiere', humor: 'celebrity treatment for mundane product' },
  { context: 'product placed on a podium with gold/silver/bronze positions, confetti falling, competition winner', humor: 'champion energy, first place' },
  { context: 'product on a therapist couch with a notepad-holding hand visible, neutral office background', humor: 'product needs therapy / telling its story' },
  { context: 'product in a museum display case with a tiny placard, gallery visitors blurred in background, velvet rope', humor: 'treated as fine art / priceless artifact' },
  { context: 'product at a job interview across a desk from someone in a suit, resume papers visible', humor: 'overqualified product, corporate absurdity' },
  { context: 'product sitting in a school desk in a classroom, chalkboard with equations behind, backpack on floor', humor: 'back to school, student life' },
];

/**
 * Selecciona N escenas aleatorias de un pool, sin repetir.
 */
function pickRandomScenes(pool, count) {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

const SYSTEM_PROMPT = `You are a world-class creative director and prompt engineer specializing in Meta Ads (Facebook/Instagram) for ecommerce. You write prompts for OpenAI's gpt-image-1.5 image editing model.

THE SETUP: The user will give you a style, 3 scene descriptions, and optionally REFERENCE IMAGES of the actual product. You will generate 3 rich, detailed, creative prompts — one per scene. OpenAI receives the REAL product photo + your prompt. Your prompt describes the WORLD AROUND the product. Each prompt will be generated twice (1:1 feed and 9:16 stories) — so write format-agnostic scenes. Do NOT mention specific aspect ratios in your prompts.

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
 REFERENCE IMAGES — ANALYZE CAREFULLY
═══════════════════════════════════════════════════════════════

If the user provides reference images of the product, you MUST carefully analyze them to understand:
- What the product actually IS (shape, size, packaging type, colors)
- What kind of environments this product would REALISTICALLY appear in
- The scale of the product — scenes must make sense for the product's real size
- What surfaces/contexts are NATURAL for this specific product (e.g. food = kitchen/table, cosmetics = bathroom/vanity, tech = desk/hand)

Use this visual understanding to TAILOR every scene. A jar of pickles should NOT appear on a yoga mat. A lipstick should NOT be on a car dashboard next to fishing tackle. Make every scene feel like a REAL moment where this SPECIFIC product would naturally be found in someone's life.

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
 ORGANIC REALISM — THE #1 PRIORITY
═══════════════════════════════════════════════════════════════

Every image must look like a REAL, UNPLANNED moment captured on someone's phone. This is the single most important quality for ad performance on Meta.

ORGANIC means:
- The scene looks like it ALREADY EXISTED before someone grabbed their phone
- Objects are placed naturally, not arranged — things overlap, lean, are slightly askew
- The environment has REAL WEAR: scratches on surfaces, water rings, dust, fingerprints
- Lighting comes from a REAL SOURCE in the environment (window, lamp, overhead light) — NOT a studio setup
- The product looks like someone SET IT DOWN casually, not PLACED IT for a photo
- Props and clutter are things that ACTUALLY EXIST together in real life
- There's a sense of INTERRUPTED LIFE — someone was doing something and stopped to snap a photo

NEVER create scenes that feel:
- Staged or arranged for a photoshoot
- Too clean, too perfect, too symmetrical
- Like a stock photo or catalog image
- Fictional or fantasy — no impossible scenarios for everyday products
- Like CGI or 3D renders

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

For UGLY-AD style (REQUIRED — this is what makes ugly ads convert):
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
- VARIETY: each of your 6 prompts must have DIFFERENT text content. Don't repeat phrases across prompts.
- Be SPECIFIC in the prompt about what text to write and where to place it. Example: "In the upper-left corner, messy handwritten text in black marker reads 'ok hear me out...' with an arrow curving down toward the product. In the bottom-right, scribbled in red pen: 'obsessed ngl' with a circle doodle around it."

For UGC style:
- Optional but recommended: 1-2 casual reaction texts
- "just arrived!!" / "omg finally" / "the unboxing energy is real" / "ok this is cute"
- Placed naturally in the scene, handwritten or typed-looking

For MEME style (REQUIRED):
- Bold white Impact font text with black outline
- TOP TEXT: the setup/situation (e.g. "WHEN YOUR FRIEND SAYS THEY DON'T NEED THIS")
- BOTTOM TEXT: the punchline (e.g. "THEY LYING")
- Classic meme format — text in top and bottom margins, NOT on the product

For POLISHED style:
- NO text overlays. Clean, premium, editorial. Let the product speak.

═══════════════════════════════════════════════════════════════
 STYLES — CREATIVE DIRECTION
═══════════════════════════════════════════════════════════════

## ugly-ad (HIGHEST PRIORITY — best ROAS performer)
The money maker. Must look like a REAL PERSON took this with their phone in a REAL MOMENT. NOT an agency. NOT polished. NOT staged.
SCENE: Use the assigned scene. Be hyper-specific about the physical clutter, mess, and real-life objects around the product. The scene should feel like it ALREADY EXISTED — the person just set the product down in the middle of their actual life and snapped a photo. Include incidental details: a half-read magazine, a phone charging cable, water condensation on a glass. Things that make it feel LIVED-IN and ORGANIC.
LIGHTING: Uneven, natural, from a REAL source in the environment. Fluorescent, window light, lamp — whatever matches the location. Imperfect. Include artifacts of real phone photography: slight overexposure near windows, warm color casts from incandescent bulbs, mixed color temperatures in the same scene.
CAMERA: "Photograph taken with iPhone 14, native camera app, auto settings, no editing. Slightly off-center, casual framing, phone held at a natural angle as if the person stopped what they were doing to take a quick photo. Mild lens distortion, real sensor noise, JPEG compression artifacts visible. Slight motion blur from hand-holding. No color grading, no filters, no post-processing."
TEXT: REQUIRED. 2-4 handwritten text elements + arrows + doodles. See TEXT OVERLAYS section above.
MOOD: casual, relatable, unpolished, organic, real-life moment, "took this with my phone real quick", anti-ad energy.

## ugc (User Generated Content)
Feels like someone sharing a genuine moment with their product on social media — NOT a scripted influencer post.
SCENE: First-person POV — camera looking down at the product. Hands visible reaching toward (but not covering) the product. Use the assigned setting. The environment should feel REAL and LIVED-IN — a real person's actual kitchen, real coffee table, real desk. Include small imperfections: a smudge on a surface, slightly wrinkled fabric, a stray crumb.
LIGHTING: As specified in scene. Natural, warm, slightly overexposed highlights from windows. The lighting should feel ACCIDENTAL, not set up — like the person just happened to be in good light.
CAMERA: "iPhone selfie-angle, vertical framing, slightly blown-out highlights, warm color cast, casual autofocus, JPEG quality. The camera angle is natural — held slightly above and looking down, as someone would actually hold their phone to snap a photo of something on a table."
TEXT: 1-2 casual reaction texts recommended. See TEXT OVERLAYS section.
MOOD: excited, genuine, organic moment, "just had to share this", real-person energy.

## polished (Premium Product Photography)
High-end editorial product photography — BUT still grounded in reality.
SCENE: Use the assigned surface and props. Minimalist, intentional, premium. Single product centered, props placed around (not overlapping). Even polished shots should feel like a real photograph taken in a real space — NOT a CGI render.
LIGHTING: As specified in scene. Professional, directional, controlled but NATURAL-looking.
CAMERA: "Shot on full-frame DSLR, 85mm f/1.4 lens, shallow depth of field, background softly blurred. Sharp focus on the product. Natural color science, correct white balance."
TEXT: NONE. Clean. Let the product and scene speak.
MOOD: premium, clean, trustworthy, aspirational, editorial.

## meme (Meme Format)
Viral, funny, shareable.
SCENE: Use the absurd/funny context provided. The humor comes from putting the product in an unexpected situation. Must still look like a REAL photograph taken with a phone — not a digital collage or CGI scene.
CAMERA: "Low quality JPEG, internet-compressed, possibly screenshot quality, casual framing. Looks like someone took a quick photo of something funny and shared it."
TEXT: REQUIRED. Bold Impact font meme text. Top + bottom. See TEXT OVERLAYS section.
MOOD: funny, shareable, absurd, viral, internet culture.

═══════════════════════════════════════════════════════════════
 PROMPT STRUCTURE (for each of the 6 prompts)
═══════════════════════════════════════════════════════════════

Write each prompt as a flowing, detailed paragraph (not a numbered list). Follow this order:

1. OPENER: "Edit this product photograph. Change ONLY the background and surroundings. [style] photograph."
2. PRESERVATION: The concise product preservation instruction (see above).
3. CAMERA: Exact device, lens, settings, angle, distance.
4. SCENE: Rich, detailed description of the physical environment. Name specific objects, textures, materials, colors, mess, props. 5-8 specific items/details minimum. Paint the picture.
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
      "prompt": "The complete detailed prompt in English. Minimum 150 words. Rich, vivid, specific. The text overlay section should be the most detailed part for ugly-ad and meme styles. Do NOT mention any aspect ratio or format.",
      "scene_label": "Short label in Spanish, 2-5 words (e.g. 'Cocina desordenada', 'Mesa de noche')"
    }
  ],
  "style_rationale": "Brief explanation in Spanish of why these scenes work for this product",
  "suggested_headline": "Ad headline in Spanish",
  "suggested_body": "Ad body text in Spanish (1-2 lines)"
}

You MUST generate exactly ONE prompt for EACH scene option provided. 3 scenes = 3 prompts. Each prompt uses its assigned scene — no skipping, no repeating.`;

/**
 * Genera un prompt optimizado para image-to-image.
 * @param {Object} options
 * @param {string} options.style - Estilo deseado (ugly-ad, polished, ugc, meme)
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

  // Build style performance context
  let styleContext = '';
  if (styleData.length > 0) {
    const lines = styleData.map(s =>
      `- Estilo "${s.style}": ${s.count} creativos, ROAS promedio ${s.avg_roas?.toFixed(1) || 'N/A'}x, CTR promedio ${s.avg_ctr?.toFixed(2) || 'N/A'}%`
    ).join('\n');
    styleContext = `\nSTYLE PERFORMANCE DATA (from creative bank):\n${lines}\nUse this data to reinforce why the "${style}" style is effective.\n`;
  }

  // Build scene performance context — which scenes have proven results
  let scenePerformanceContext = '';
  const validScenePerformance = (scenePerformance || []).filter(s => s.scene_label && typeof s.scene_label === 'string');
  if (validScenePerformance.length > 0) {
    const sceneLines = validScenePerformance.map(s =>
      `- "${s.scene_label}": ROAS ${s.avg_roas?.toFixed(1) || 'N/A'}x, CTR ${s.avg_ctr?.toFixed(2) || 'N/A'}%, used ${s.total_used}x across ${s.count} creatives`
    ).join('\n');
    scenePerformanceContext = `\nSCENE PERFORMANCE DATA (proven scene types by ROAS — use as creative direction):\n${sceneLines}\nThese scene types have PROVEN results. Lean into similar environments, moods, and contexts when crafting your prompts. You don't need to copy them exactly — use them as INSPIRATION for what kind of settings resonate with the audience.\n`;
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
        text: `[THIS IS THE PRODUCT IMAGE that OpenAI will receive. Analyze it carefully — understand the product's shape, size, packaging, and colors. Tailor your scene prompts specifically for THIS product.]`
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
    productContext += `\nUse this context to create scenes that make sense for THIS specific product. Think about where, how, and when people use/consume/display this product.\n`;
  }

  // Build dynamic scene options based on style — pick 3 for variety
  // Each scene gets generated in BOTH 1:1 (feed) and 9:16 (stories) = 6 images total
  // Smart selection: if we have scene performance data, bias toward proven scene types
  // while keeping ~30% exploration for discovering new winning scenes
  const NUM_SCENES = 3;

  /**
   * Smart scene picker: biases selection toward scenes matching proven scene_labels
   * while keeping exploration. ~70% exploitation (proven scenes), ~30% exploration (random).
   */
  function pickSmartScenes(pool, count, scenePerf, locationKey) {
    // Filter out any entries with null/empty scene_label
    const validScenePerf = (scenePerf || []).filter(s => s.scene_label && typeof s.scene_label === 'string');
    if (validScenePerf.length === 0) {
      return pickRandomScenes(pool, count);
    }

    // How many slots for proven scenes vs exploration
    const provenSlots = Math.min(Math.ceil(count * 0.7), count - 1); // At least 1 slot for exploration
    const explorationSlots = count - provenSlots;

    // Build a set of proven location/context keywords from scene_labels
    const provenKeywords = validScenePerf.map(s => s.scene_label.toLowerCase());

    // Score each scene by how well it matches proven scene_labels
    const scored = pool.map(scene => {
      const sceneText = (scene[locationKey] || scene.surface || scene.context || '').toLowerCase();
      let score = 0;
      for (const kw of provenKeywords) {
        // Check if any word from the proven label appears in the scene description
        const kwWords = kw.split(/\s+/);
        for (const word of kwWords) {
          if (word.length > 3 && sceneText.includes(word)) {
            score += 1;
          }
        }
      }
      return { scene, score };
    });

    // Separate into proven-matching and other scenes
    const provenPool = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
    const otherPool = scored.filter(s => s.score === 0);

    const selected = [];
    const usedIndices = new Set();

    // Fill proven slots
    const shuffledProven = [...provenPool].sort(() => Math.random() - 0.5);
    for (let i = 0; i < provenSlots && i < shuffledProven.length; i++) {
      selected.push(shuffledProven[i].scene);
      usedIndices.add(pool.indexOf(shuffledProven[i].scene));
    }

    // Fill exploration slots (and remaining proven slots if not enough proven matches)
    const remaining = count - selected.length;
    const shuffledOther = [...otherPool].sort(() => Math.random() - 0.5);
    const fallbackShuffled = [...provenPool].sort(() => Math.random() - 0.5);
    const explorationCandidates = [...shuffledOther, ...fallbackShuffled].filter(s => !usedIndices.has(pool.indexOf(s.scene)));

    for (let i = 0; i < remaining && i < explorationCandidates.length; i++) {
      selected.push(explorationCandidates[i].scene);
    }

    // If still not enough, fill with pure random from pool
    if (selected.length < count) {
      const extraNeeded = count - selected.length;
      const extraCandidates = pool.filter(s => !selected.includes(s)).sort(() => Math.random() - 0.5);
      selected.push(...extraCandidates.slice(0, extraNeeded));
    }

    return selected.slice(0, count);
  }

  let sceneBlock = '';
  if (style === 'ugly-ad') {
    const scenes = pickSmartScenes(UGLY_AD_SCENES, NUM_SCENES, scenePerformance, 'location');
    const sceneLines = scenes.map((s, i) =>
      `SCENE ${i + 1} [${s.location}]: Surface: ${s.surface} | Lighting: ${s.lighting} | Camera angle: ${s.angle}`
    ).join('\n');
    sceneBlock = `\nSCENE OPTIONS — generate ONE prompt for EACH scene (${scenes.length} total):\n${sceneLines}\nExpand each scene with additional hyper-specific details relevant to the product.\n`;
  } else if (style === 'ugc') {
    const scenes = pickSmartScenes(UGC_SCENES, NUM_SCENES, scenePerformance, 'surface');
    const sceneLines = scenes.map((s, i) =>
      `SCENE ${i + 1}: Setting: ${s.surface} | Lighting: ${s.lighting} | POV: ${s.pov}`
    ).join('\n');
    sceneBlock = `\nSCENE OPTIONS — generate ONE prompt for EACH scene (${scenes.length} total):\n${sceneLines}\nAdapt each scene to fit the product naturally.\n`;
  } else if (style === 'polished') {
    const scenes = pickSmartScenes(POLISHED_SCENES, NUM_SCENES, scenePerformance, 'surface');
    const sceneLines = scenes.map((s, i) =>
      `SCENE ${i + 1}: Surface: ${s.surface} | Lighting: ${s.lighting}`
    ).join('\n');
    sceneBlock = `\nSCENE OPTIONS — generate ONE prompt for EACH scene (${scenes.length} total):\n${sceneLines}\nUse each surface and lighting as the foundation for its prompt.\n`;
  } else if (style === 'meme') {
    const scenes = pickSmartScenes(MEME_SCENES, NUM_SCENES, scenePerformance, 'context');
    const sceneLines = scenes.map((s, i) =>
      `SCENE ${i + 1}: Context: ${s.context} | Humor angle: ${s.humor}`
    ).join('\n');
    sceneBlock = `\nSCENE OPTIONS — generate ONE prompt for EACH scene (${scenes.length} total):\n${sceneLines}\nUse each absurd context. Create unique meme text for each.\n`;
  }

  const userMessage = `Generate 3 image-editing prompts for Meta Ads. OpenAI gpt-image-1.5 will receive the real product photo + your prompt. Each prompt will be rendered in BOTH 1:1 (feed) and 9:16 (stories) formats, so write format-agnostic scene descriptions.

PRODUCT: ${productName || 'Product from the creative bank'}
STYLE: ${style}
${productContext}${styleContext}${scenePerformanceContext}${referenceContext}${sceneBlock}
${userInstruction ? `USER INSTRUCTION (apply creatively to ALL prompts): ${userInstruction}` : ''}

REQUIREMENTS:
- Generate exactly 3 prompts, one for each scene listed above
- Each prompt must be a rich, flowing paragraph — NOT a bulleted list
- Follow the prompt structure from your instructions (opener → preservation → camera → scene → lighting → text overlays → mood → closing)
- NEVER describe the product itself — only the world around it
- Do NOT mention any aspect ratio or format (1:1, 9:16, square, vertical, etc.) — the system adds this automatically
- Each scene must feel completely different from the others

TEXT OVERLAYS — MAKE THEM GREAT:
${style === 'ugly-ad' ? `- REQUIRED in every prompt. This is what makes ugly ads convert on Meta.
- Include 2-4 handwritten text elements per prompt with EXACT text content, style, color, and placement
- Each prompt MUST have UNIQUE text — different phrases, different placement, different personality
- Use casual English internet/TikTok language — relatable, funny, unhinged, real
- Add arrows, doodles, circles, underlines — the messier the better
- Be VERY SPECIFIC: "In the upper-left corner, handwritten in thick black marker: 'ok hear me out...' with a wobbly arrow curving toward the product. Bottom-right, scribbled in red pen: 'obsessed ngl' circled twice."
- NEVER place text on top of the product label` : style === 'meme' ? `- REQUIRED. Bold white Impact font with black outline.
- TOP TEXT: setup/situation. BOTTOM TEXT: punchline.
- Make it genuinely funny and shareable. Each prompt needs unique meme text.
- Classic meme layout — text in margins, not on the product.` : style === 'ugc' ? `- Recommended: 1-2 casual reaction texts per prompt ("just arrived!!", "omg finally", "this is it")
- Handwritten or typed-looking, placed naturally in the scene` : `- No text for polished style. Clean and editorial.`}

SCENE RICHNESS:
- Name at least 5-8 specific physical objects/details in each scene
- Include textures, materials, colors, imperfections, real-life mess
- The more specific and vivid, the better OpenAI will execute it

ORGANIC REALISM:
- Every scene MUST feel like a real moment someone captured on their phone
- The product should look CASUALLY PLACED, not arranged — as if the person set it down naturally
- Include real-life imperfections: crumbs, water rings, slightly wrinkled fabric, dust
- Lighting should come from real environmental sources — windows, lamps, overhead lights
- NEVER create scenes that feel staged, too clean, or like stock photography
- Think: "what would this product actually look like sitting in someone's REAL kitchen/desk/car?"

${referenceImageBlocks.length > 0 ? `PRODUCT IMAGES PROVIDED:
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
  logger.info(`[PROMPT-GEN] Generando ${NUM_SCENES} prompts con Claude (estilo: ${style}, dual format 1:1+9:16, imagenes ref: ${referenceImageBlocks.filter(b => b.type === 'image').length}, top performers: ${topPerformerImageBlocks.filter(b => b.type === 'image').length})`);
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
    style,
    format,
    generation_time_s: parseFloat(elapsed)
  };
}

module.exports = { generatePrompt };
