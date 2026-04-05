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
    model: 'gemini-3-pro-image-preview',
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['IMAGE', 'TEXT'],
      imageConfig: {
        aspectRatio: '9:16',
        imageSize: '2K'
      }
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

  // 1. Upload image to Meta (expects file path)
  if (!fs.existsSync(imagePath)) throw new Error(`Image file not found: ${imagePath}`);
  const imageHash = await meta.uploadImage(imagePath);

  // 2. Create ad creative using existing meta client method
  const pageId = process.env.META_PAGE_ID;
  const creative = await meta.createAdCreative({
    page_id: pageId,
    image_hash: imageHash,
    headline: headline,
    body: primaryText,
    description: '',
    cta: 'SHOP_NOW',
    link_url: linkUrl
  });

  // 3. Create ad in the ad set
  const adName = `${headline} [AI Creative Agent]`;
  const ad = await meta.createAd(adsetId, creative.creative_id, adName, 'ACTIVE');

  return { adId: ad.id, creativeId: creative.creative_id, adName, imageHash };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN: RUN CREATIVE AGENT
// ═══════════════════════════════════════════════════════════════════════════════

const CreativeProposal = require('../../db/models/CreativeProposal');

/**
 * Run the Creative Agent.
 * Generates images + copy and saves as proposals for user approval.
 * Does NOT upload to Meta — user approves first.
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

  // Also skip ad sets that already have pending proposals
  const pendingAdSets = await CreativeProposal.distinct('adset_id', { status: 'pending' });
  const pendingSet = new Set(pendingAdSets);
  const filtered = needCreatives.filter(m => !pendingSet.has(m.entity_id));

  if (filtered.length === 0) {
    logger.info('[CREATIVE-AGENT] No ad sets need creatives (or already have pending proposals)');
    return { generated: 0, elapsed: '0s', cycle_id: cycleId };
  }

  logger.info(`[CREATIVE-AGENT] ${filtered.length} ad sets need creatives`);

  // 2. Get available products
  const products = await ProductBank.find({ active: true }).lean();
  if (products.length === 0) {
    logger.warn('[CREATIVE-AGENT] No products in bank — cannot generate creatives');
    return { generated: 0, elapsed: '0s', cycle_id: cycleId, error: 'No products in bank' };
  }

  // 3. Learn from past approvals/rejections
  const pastProposals = await CreativeProposal.find({
    status: { $in: ['approved', 'rejected'] }
  }).sort({ created_at: -1 }).limit(50).lean();

  const approvedScenes = {};
  const rejectedScenes = {};
  for (const p of pastProposals) {
    const s = p.scene_short || 'unknown';
    if (p.status === 'approved') approvedScenes[s] = (approvedScenes[s] || 0) + 1;
    if (p.status === 'rejected') rejectedScenes[s] = (rejectedScenes[s] || 0) + 1;
  }

  let generated = 0;
  const results = [];
  const uploadsDir = path.join(config.system.uploadsDir || 'uploads', 'ai-creatives');

  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  for (const memory of filtered) {
    const adsetId = memory.entity_id;
    const adsetName = memory.entity_name;

    try {
      // Pick product
      let product = null;
      for (const p of products) {
        if ((adsetName || '').toLowerCase().includes(p.product_slug.toLowerCase()) ||
            (adsetName || '').toLowerCase().includes(p.product_name.toLowerCase())) {
          product = p;
          break;
        }
      }
      if (!product) {
        product = products.sort((a, b) => (b.performance?.avg_roas || 0) - (a.performance?.avg_roas || 0))[0];
      }

      if (!product.png_references || product.png_references.length === 0) {
        logger.warn(`[CREATIVE-AGENT] Product "${product.product_name}" has no PNG references — skipping`);
        continue;
      }

      // Pick scene — weighted by approval history
      let scene, sceneShort;
      const availableScenes = SCENES.filter(s => {
        const short = s.substring(0, 40);
        const rejCount = rejectedScenes[short] || 0;
        const appCount = approvedScenes[short] || 0;
        return rejCount < 3 || appCount > rejCount; // skip scenes rejected 3+ times without approvals
      });
      const scenePool = availableScenes.length > 0 ? availableScenes : SCENES;
      scene = scenePool[Math.floor(Math.random() * scenePool.length)];
      sceneShort = scene.substring(0, 40);

      // Build references
      const refPaths = product.png_references.map(ref =>
        path.join(config.system.uploadsDir || 'uploads', 'product-bank', ref.filename)
      );
      const refTypes = product.png_references.map(ref => ref.type);

      // Build prompt
      const prompt = buildImagePrompt(product.product_name, scene, refTypes);

      // Generate image
      const outputFilename = `creative_${adsetId}_${Date.now()}.png`;
      const outputPath = path.join(uploadsDir, outputFilename);

      logger.info(`[CREATIVE-AGENT] Generating image for ${adsetName} — ${sceneShort}...`);
      await generateImage(prompt, refPaths, outputPath);

      // Generate copy
      const copy = await generateCopy(product.product_name, sceneShort);

      // Read image as base64 for DB storage (Render has ephemeral filesystem)
      const imageBase64 = fs.readFileSync(outputPath).toString('base64');

      // Save as proposal (NOT uploaded yet)
      await CreativeProposal.create({
        adset_id: adsetId,
        adset_name: adsetName,
        product_id: product._id,
        product_name: product.product_name,
        image_path: outputPath,
        image_filename: outputFilename,
        image_base64: imageBase64,
        scene,
        scene_short: sceneShort,
        headline: copy.headline,
        primary_text: copy.primary_text,
        link_url: product.link_url || 'https://jerseypickles.com',
        prompt_used: prompt,
        status: 'pending'
      });

      generated++;
      results.push({
        adset_id: adsetId,
        adset_name: adsetName,
        product: product.product_name,
        scene: sceneShort,
        headline: copy.headline,
        status: 'pending_approval'
      });

      logger.info(`[CREATIVE-AGENT] ✅ ${adsetName}: "${copy.headline}" — pendiente de aprobacion`);

    } catch (err) {
      logger.error(`[CREATIVE-AGENT] Error for ${adsetName}: ${err.message}`);
      results.push({ adset_id: adsetId, adset_name: adsetName, error: err.message });
    }
  }

  const elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  logger.info(`═══ Creative Agent completado [${cycleId}]: ${generated} propuestas generadas en ${elapsed} ═══`);

  return { generated, results, elapsed, cycle_id: cycleId };
}

/**
 * Approve a creative proposal — upload to Meta.
 */
async function approveProposal(proposalId) {
  const proposal = await CreativeProposal.findById(proposalId);
  if (!proposal) throw new Error('Proposal not found');
  if (proposal.status !== 'pending') throw new Error(`Proposal is ${proposal.status}, not pending`);

  // Upload to Meta — use file if exists, otherwise write base64 to temp file
  let imagePath = proposal.image_path;

  if (!imagePath || !fs.existsSync(imagePath)) {
    if (!proposal.image_base64) throw new Error('No image data available — file missing and no base64 in DB');
    // Write base64 to temp file
    const tmpDir = path.join(require('os').tmpdir(), 'creative-agent');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    imagePath = path.join(tmpDir, `proposal_${proposal._id}.png`);
    fs.writeFileSync(imagePath, Buffer.from(proposal.image_base64, 'base64'));
  }

  const uploadResult = await uploadToMeta(
    proposal.adset_id,
    imagePath,
    proposal.headline,
    proposal.primary_text,
    proposal.link_url
  );

  // Update proposal
  proposal.status = 'uploaded';
  proposal.decided_at = new Date();
  proposal.meta_ad_id = uploadResult.adId;
  proposal.meta_creative_id = uploadResult.creativeId;
  proposal.meta_ad_name = uploadResult.adName;
  await proposal.save();

  // Log
  await ActionLog.create({
    entity_type: 'adset',
    entity_id: proposal.adset_id,
    entity_name: proposal.adset_name,
    action: 'create_ad',
    after_value: uploadResult.adName,
    reasoning: `[CREATIVE-AGENT] Approved: "${proposal.headline}" for ${proposal.product_name} (${proposal.scene_short})`,
    confidence: 'high',
    agent_type: 'creative_agent',
    success: true,
    new_entity_id: uploadResult.adId
  });

  // Clear needs_new_creatives flag
  await BrainMemory.findOneAndUpdate(
    { entity_id: proposal.adset_id },
    { $set: { agent_needs_new_creatives: false, last_updated_at: new Date() } }
  );

  // Update product stats
  await ProductBank.findByIdAndUpdate(proposal.product_id, {
    $inc: { 'performance.total_ads_created': 1 },
    $set: { updated_at: new Date() }
  });

  logger.info(`[CREATIVE-AGENT] Proposal ${proposalId} approved and uploaded as ${uploadResult.adId}`);
  return { success: true, ad_id: uploadResult.adId, ad_name: uploadResult.adName };
}

/**
 * Reject a creative proposal.
 */
async function rejectProposal(proposalId, reason = '') {
  const proposal = await CreativeProposal.findById(proposalId);
  if (!proposal) throw new Error('Proposal not found');
  if (proposal.status !== 'pending') throw new Error(`Proposal is ${proposal.status}, not pending`);

  proposal.status = 'rejected';
  proposal.decided_at = new Date();
  proposal.rejection_reason = reason;
  await proposal.save();

  logger.info(`[CREATIVE-AGENT] Proposal ${proposalId} rejected: ${reason || 'no reason'}`);
  return { success: true };
}

module.exports = { runCreativeAgent, approveProposal, rejectProposal, generateImage, generateCopy, uploadToMeta, SCENES };
