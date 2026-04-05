const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const config = require('../../../config');
const logger = require('../../utils/logger');
const BrainMemory = require('../../db/models/BrainMemory');
const BrainInsight = require('../../db/models/BrainInsight');
const ProductBank = require('../../db/models/ProductBank');
const ActionLog = require('../../db/models/ActionLog');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const { getLatestSnapshots } = require('../../db/queries');

const claude = new Anthropic({ apiKey: config.claude.apiKey });

// ═══════════════════════════════════════════════════════════════════════════════
// SCENES BANK — escenas cotidianas para creative generation
// ═══════════════════════════════════════════════════════════════════════════════
const SCENES = [
  'parked car during daytime, container placed near cupholder with a crumpled napkin nearby, hand lifting a pickle from container with slight dripping brine',
  'living room couch at night watching TV, container on armrest with a blanket nearby and remote control visible, hand reaching in to grab a pickle',
  'beach towel on a sunny day, container on colorful towel with sunscreen and flip flops nearby, hand pulling out a pickle chip',
  'office desk during lunch break, container next to laptop and coffee mug, casual mid-bite moment',
  'kitchen counter while cooking, container open next to cutting board with ingredients around, hand grabbing a pickle',
  'backyard BBQ party, container on picnic table next to paper plates and drinks, casual outdoor setting',
  'picnic blanket in a park, container among other snacks on checkered blanket, natural sunlight',
  'grocery store aisle, hands holding the container showing the label, fluorescent store lighting',
  'road trip passenger seat, container between seats with snacks and water bottles around',
  'camping outdoors, container on a fold-out table near campfire setup, rustic outdoor mood',
  'tailgate party near a truck, container on cooler lid with drinks around, game day vibe',
  'pool side on a towel, container next to sunglasses and a drink, summer relaxation mood'
];

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPT TEMPLATE
// ═══════════════════════════════════════════════════════════════════════════════
function buildImagePrompt(productName, scene, refTypes) {
  let prompt = 'Use the uploaded ';

  // Describe references based on what was provided
  if (refTypes.includes('front-view')) {
    prompt += `front-view ${productName} container image as the primary mandatory reference for the exact package identity, container proportions, and front label. `;
  }
  if (refTypes.includes('top-down') || refTypes.includes('open')) {
    prompt += `Use the uploaded top-down/open container image as the secondary reference for the true appearance of the contents inside. `;
  }

  prompt += `Create a realistic ugly-ad style iPhone photo of ${scene}. `;
  prompt += 'Keep the framing casual, the light natural, and the overall mood believable and unpolished. ';
  prompt += 'The photo should look like someone casually took it with their phone — not staged or professional.';

  return prompt;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GEMINI IMAGE GENERATION
// ═══════════════════════════════════════════════════════════════════════════════
async function generateImage(prompt, referencePaths, outputPath) {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY not configured');

  const genAI = new GoogleGenAI({ apiKey });

  // Build parts: text prompt + reference images
  const parts = [{ text: prompt }];

  for (const refPath of referencePaths) {
    try {
      const absPath = path.resolve(refPath);
      const imageData = fs.readFileSync(absPath);
      const base64 = imageData.toString('base64');
      const ext = path.extname(refPath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

      parts.push({
        inlineData: {
          mimeType,
          data: base64
        }
      });
    } catch (err) {
      logger.warn(`[CREATIVE-AGENT] Could not read reference image ${refPath}: ${err.message}`);
    }
  }

  const response = await genAI.models.generateContent({
    model: 'gemini-2.0-flash-exp',
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['image', 'text'],
    }
  });

  // Extract image from response
  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
      fs.writeFileSync(outputPath, imageBuffer);
      logger.info(`[CREATIVE-AGENT] Image generated: ${outputPath}`);
      return outputPath;
    }
  }

  throw new Error('Gemini did not return an image');
}

// ═══════════════════════════════════════════════════════════════════════════════
// COPY GENERATION (Claude)
// ═══════════════════════════════════════════════════════════════════════════════
async function generateCopy(productName, scene) {
  const response = await claude.messages.create({
    model: config.claude.model,
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Write ad copy for Jersey Pickles "${productName}" in a ${scene} setting.

Return JSON only:
{
  "headline": "short punchy headline (max 40 chars)",
  "primary_text": "engaging ad text (max 125 chars) with 1-2 emojis"
}

Style: casual, fun, crave-inducing. Like a friend recommending a snack. English only.`
    }]
  });

  try {
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    logger.warn(`[CREATIVE-AGENT] Copy parse error: ${e.message}`);
  }

  // Fallback
  return {
    headline: `Try ${productName} Today`,
    primary_text: `Jersey Pickles ${productName} — the snack you didn't know you needed. Grab a jar! 🥒🔥`
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPLOAD TO META
// ═══════════════════════════════════════════════════════════════════════════════
async function uploadToMeta(adsetId, imagePath, headline, primaryText, linkUrl) {
  const { getMetaClient } = require('../../meta/client');
  const meta = getMetaClient();

  // 1. Upload image to Meta
  const imageBuffer = fs.readFileSync(imagePath);
  const imageHash = await meta.uploadImage(imageBuffer);

  // 2. Create ad creative
  const creativeName = `AI Creative - ${path.basename(imagePath, path.extname(imagePath))}`;
  const pageId = process.env.META_PAGE_ID;

  const creativeResponse = await meta.post(`/act_${config.meta.adAccountId}/adcreatives`, {
    name: creativeName,
    object_story_spec: JSON.stringify({
      page_id: pageId,
      link_data: {
        image_hash: imageHash,
        link: linkUrl,
        message: primaryText,
        name: headline,
        call_to_action: { type: 'SHOP_NOW', value: { link: linkUrl } }
      }
    })
  });

  const creativeId = creativeResponse.id;

  // 3. Create ad in the ad set
  const adName = `${headline} [AI Creative Agent]`;
  const adResponse = await meta.post(`/act_${config.meta.adAccountId}/ads`, {
    name: adName,
    adset_id: adsetId,
    creative: JSON.stringify({ creative_id: creativeId }),
    status: 'ACTIVE'
  });

  return { adId: adResponse.id, creativeId, adName, imageHash };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN: RUN CREATIVE AGENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run the Creative Agent.
 * Checks for ad sets needing creatives, generates images + copy, uploads to Meta.
 */
async function runCreativeAgent() {
  const startTime = Date.now();
  const cycleId = `creative_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  logger.info(`═══ Iniciando Creative Agent [${cycleId}] ═══`);

  // 1. Check for ad sets needing creatives
  const needCreatives = await BrainMemory.find({
    agent_needs_new_creatives: true,
    entity_type: 'adset'
  }).lean();

  if (needCreatives.length === 0) {
    logger.info('[CREATIVE-AGENT] No ad sets need creatives');
    return { generated: 0, uploaded: 0, elapsed: '0s', cycle_id: cycleId };
  }

  logger.info(`[CREATIVE-AGENT] ${needCreatives.length} ad sets need creatives`);

  // 2. Get available products
  const products = await ProductBank.find({ active: true }).lean();
  if (products.length === 0) {
    logger.warn('[CREATIVE-AGENT] No products in bank — cannot generate creatives');
    return { generated: 0, uploaded: 0, elapsed: '0s', cycle_id: cycleId, error: 'No products in bank' };
  }

  let generated = 0;
  let uploaded = 0;
  const results = [];
  const uploadsDir = path.join(config.system.uploadsDir || 'uploads', 'ai-creatives');

  // Ensure output directory exists
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  for (const memory of needCreatives) {
    const adsetId = memory.entity_id;
    const adsetName = memory.entity_name;

    try {
      // 3. Pick a product — try to match from ad set name, or use best performing
      let product = null;
      for (const p of products) {
        if ((adsetName || '').toLowerCase().includes(p.product_slug.toLowerCase()) ||
            (adsetName || '').toLowerCase().includes(p.product_name.toLowerCase())) {
          product = p;
          break;
        }
      }
      // Fallback: use product with best avg_roas, or first available
      if (!product) {
        product = products.sort((a, b) => (b.performance?.avg_roas || 0) - (a.performance?.avg_roas || 0))[0];
      }

      if (!product.png_references || product.png_references.length === 0) {
        logger.warn(`[CREATIVE-AGENT] Product "${product.product_name}" has no PNG references — skipping`);
        continue;
      }

      // 4. Pick a scene — random for now, later weighted by performance
      const sceneIdx = Math.floor(Math.random() * SCENES.length);
      const scene = SCENES[sceneIdx];
      const sceneShort = scene.substring(0, 40);

      // 5. Build reference paths
      const refPaths = product.png_references.map(ref =>
        path.join(config.system.uploadsDir || 'uploads', 'product-bank', ref.filename)
      );
      const refTypes = product.png_references.map(ref => ref.type);

      // 6. Build prompt
      const prompt = buildImagePrompt(product.product_name, scene, refTypes);

      // 7. Generate image with Gemini
      const outputFilename = `creative_${adsetId}_${Date.now()}.png`;
      const outputPath = path.join(uploadsDir, outputFilename);

      logger.info(`[CREATIVE-AGENT] Generating image for ${adsetName} — ${sceneShort}...`);
      await generateImage(prompt, refPaths, outputPath);
      generated++;

      // 8. Generate copy with Claude
      const copy = await generateCopy(product.product_name, sceneShort);

      // 9. Upload to Meta
      logger.info(`[CREATIVE-AGENT] Uploading to Meta for ad set ${adsetId}...`);
      const uploadResult = await uploadToMeta(
        adsetId,
        outputPath,
        copy.headline,
        copy.primary_text,
        product.link_url || 'https://jerseypickles.com'
      );
      uploaded++;

      // 10. Log in ActionLog
      const snap = (await getLatestSnapshots('adset')).find(s => s.entity_id === adsetId);
      const m7d = snap?.metrics?.last_7d || {};

      await ActionLog.create({
        entity_type: 'adset',
        entity_id: adsetId,
        entity_name: adsetName,
        action: 'create_ad',
        before_value: null,
        after_value: uploadResult.adName,
        reasoning: `[CREATIVE-AGENT] Generated ugly-ad style creative for "${product.product_name}" in scene "${sceneShort}". Copy: "${copy.headline}"`,
        confidence: 'medium',
        agent_type: 'creative_agent',
        success: true,
        executed_at: new Date(),
        new_entity_id: uploadResult.adId,
        metrics_at_execution: {
          roas_7d: m7d.roas || 0,
          spend_7d: m7d.spend || 0,
          purchases_7d: m7d.purchases || 0,
          frequency: m7d.frequency || 0,
          ctr: m7d.ctr || 0
        }
      });

      // 11. Log in BrainInsight for the feed
      await BrainInsight.create({
        insight_type: 'status_change',
        severity: 'info',
        entities: [{ entity_type: 'adset', entity_id: adsetId, entity_name: adsetName }],
        title: `Creative Agent genero creativo para "${adsetName}"`,
        body: `Producto: ${product.product_name}. Escena: ${sceneShort}. Headline: "${copy.headline}". Subido a Meta como "${uploadResult.adName}".`,
        generated_by: 'brain'
      });

      // 12. Clear the flag
      await BrainMemory.findOneAndUpdate(
        { entity_id: adsetId },
        { $set: { agent_needs_new_creatives: false, last_updated_at: new Date() } }
      );

      // 13. Update product performance
      await ProductBank.findByIdAndUpdate(product._id, {
        $inc: { 'performance.total_ads_created': 1 },
        $set: { updated_at: new Date() }
      });

      results.push({
        adset_id: adsetId,
        adset_name: adsetName,
        product: product.product_name,
        scene: sceneShort,
        ad_id: uploadResult.adId,
        headline: copy.headline
      });

      logger.info(`[CREATIVE-AGENT] ✅ ${adsetName}: "${copy.headline}" uploaded as ${uploadResult.adId}`);

    } catch (err) {
      logger.error(`[CREATIVE-AGENT] Error for ${adsetName}: ${err.message}`);
      results.push({
        adset_id: adsetId,
        adset_name: adsetName,
        error: err.message
      });
    }
  }

  const elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  logger.info(`═══ Creative Agent completado [${cycleId}]: ${generated} generados, ${uploaded} subidos en ${elapsed} ═══`);

  return { generated, uploaded, results, elapsed, cycle_id: cycleId };
}

module.exports = { runCreativeAgent, generateImage, generateCopy, SCENES };
