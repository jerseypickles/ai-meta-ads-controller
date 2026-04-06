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
const { getLatestSnapshots, getAdsForAdSet } = require('../../db/queries');

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
async function generateImage(prompt, referencePaths) {
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

  // Extract image as base64 directly — no filesystem needed
  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      logger.info('[CREATIVE-AGENT] Image generated (in-memory base64)');
      return part.inlineData.data; // already base64 string
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
  const upload = await meta.uploadImage(imagePath);
  const imageHash = upload.image_hash;

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

  // 1. Auto-rechazar propuestas pendientes de oleadas anteriores
  const stale = await CreativeProposal.updateMany(
    { status: 'pending' },
    { $set: { status: 'rejected', rejection_reason: 'auto: nueva oleada', decided_at: new Date() } }
  );
  if (stale.modifiedCount > 0) {
    logger.info(`[CREATIVE-AGENT] Auto-rechazadas ${stale.modifiedCount} propuestas pendientes de oleadas anteriores`);
  }

  // 2. Pre-scan: detectar ad sets con 0-1 ads activos y forzar flag (no depender del LLM)
  try {
    const activeAdsets = await getLatestSnapshots('adset');
    const onlyActive = activeAdsets.filter(s => s.status === 'ACTIVE');
    let autoFlagged = 0;

    for (const adset of onlyActive) {
      const ads = await getAdsForAdSet(adset.entity_id);
      const activeAds = ads.filter(a => a.status === 'ACTIVE');

      if (activeAds.length <= 1) {
        const mem = await BrainMemory.findOne({ entity_id: adset.entity_id }).lean();
        if (!mem?.agent_needs_new_creatives) {
          await BrainMemory.findOneAndUpdate(
            { entity_id: adset.entity_id },
            {
              $set: {
                entity_name: adset.entity_name,
                entity_type: 'adset',
                agent_needs_new_creatives: true,
                last_updated_at: new Date()
              }
            },
            { upsert: true }
          );
          autoFlagged++;
        }
      }
    }

    if (autoFlagged > 0) {
      logger.info(`[CREATIVE-AGENT] Pre-scan: ${autoFlagged} ad sets auto-flagged (0-1 active ads)`);
    }
  } catch (err) {
    logger.error(`[CREATIVE-AGENT] Pre-scan error (continuing anyway): ${err.message}`);
  }

  // 3. Check for ad sets needing creatives
  const needCreatives = await BrainMemory.find({
    agent_needs_new_creatives: true,
    entity_type: 'adset'
  }).lean();

  const filtered = needCreatives;

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

  // ── Smart scene ranking: approved scenes first, then unused, skip over-rejected ──
  const rankedScenes = SCENES
    .map(s => {
      const short = s.substring(0, 40);
      const app = approvedScenes[short] || 0;
      const rej = rejectedScenes[short] || 0;
      if (rej >= 3 && app <= rej) return null; // blacklisted
      // Score: approved scenes get big boost, unused scenes get neutral score, rejected get penalty
      const score = (app * 3) - (rej * 2) + (app === 0 && rej === 0 ? 1 : 0);
      return { scene: s, short, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (rankedScenes.length === 0) {
    logger.warn('[CREATIVE-AGENT] All scenes blacklisted — resetting to full pool');
    rankedScenes.push(...SCENES.map(s => ({ scene: s, short: s.substring(0, 40), score: 0 })));
  }

  // ── Smart product ranking: best ROAS first, then most ads created ──
  const rankedProducts = products
    .filter(p => p.png_references && p.png_references.length > 0)
    .sort((a, b) => {
      const roasA = a.performance?.avg_roas || 0;
      const roasB = b.performance?.avg_roas || 0;
      if (roasA !== roasB) return roasB - roasA; // best ROAS first
      return (b.performance?.total_ads_created || 0) - (a.performance?.total_ads_created || 0);
    });

  if (rankedProducts.length === 0) {
    logger.warn('[CREATIVE-AGENT] No products with PNG references — cannot generate');
    return { generated: 0, elapsed: '0s', cycle_id: cycleId, error: 'No products with PNGs' };
  }

  const PROPOSALS_PER_ADSET = 2;

  for (const memory of filtered) {
    const adsetId = memory.entity_id;
    const adsetName = memory.entity_name;

    try {
      // Pick product — match by name first, fallback to best ROAS
      let product = rankedProducts.find(p =>
        (adsetName || '').toLowerCase().includes(p.product_slug.toLowerCase()) ||
        (adsetName || '').toLowerCase().includes(p.product_name.toLowerCase())
      ) || rankedProducts[0];

      // Pick N different scenes for this ad set (avoid duplicates)
      const usedScenes = new Set();
      const scenePicks = [];
      for (const s of rankedScenes) {
        if (scenePicks.length >= PROPOSALS_PER_ADSET) break;
        if (!usedScenes.has(s.short)) {
          usedScenes.add(s.short);
          scenePicks.push(s);
        }
      }

      // Build references once per product
      const refPaths = product.png_references.map(ref =>
        path.join(config.system.uploadsDir || 'uploads', 'product-bank', ref.filename)
      );
      const refTypes = product.png_references.map(ref => ref.type);

      for (const scenePick of scenePicks) {
        const scene = scenePick.scene;
        const sceneShort = scenePick.short;

        // Build prompt
        const prompt = buildImagePrompt(product.product_name, scene, refTypes);

        // Generate image — returns base64 directly, no filesystem needed
        logger.info(`[CREATIVE-AGENT] Generating image for ${adsetName} — ${sceneShort}...`);
        const imageBase64 = await generateImage(prompt, refPaths);

        // Generate copy
        const copy = await generateCopy(product.product_name, sceneShort);

        // Save as proposal (NOT uploaded yet) — image stored as base64 in DB
        await CreativeProposal.create({
          adset_id: adsetId,
          adset_name: adsetName,
          product_id: product._id,
          product_name: product.product_name,
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
      }

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

  let uploadResult;
  try {
    uploadResult = await uploadToMeta(
      proposal.adset_id,
      imagePath,
      proposal.headline,
      proposal.primary_text,
      proposal.link_url
    );
  } catch (uploadErr) {
    // Upload fallo — marcar como failed pero NO limpiar el flag needs_new_creatives
    proposal.status = 'failed';
    proposal.decided_at = new Date();
    await proposal.save();
    logger.error(`[CREATIVE-AGENT] Upload failed for proposal ${proposalId}: ${uploadErr.message}`);
    throw new Error(`Upload a Meta fallo: ${uploadErr.message}`);
  }

  // Upload exitoso — actualizar proposal
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

  // Clear needs_new_creatives flag — solo si upload fue exitoso
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

/**
 * Sync performance metrics for uploaded CreativeProposals + ProductBank stats.
 * Runs as part of jobCreativeMetricsSync (every 6h).
 */
async function syncProposalPerformance() {
  const MetricSnapshot = require('../../db/models/MetricSnapshot');

  // Buscar propuestas subidas a Meta con ad ID
  const uploaded = await CreativeProposal.find({
    status: 'uploaded',
    meta_ad_id: { $ne: null }
  }).lean();

  if (uploaded.length === 0) return { synced: 0, products_updated: 0 };

  let synced = 0;

  for (const proposal of uploaded) {
    try {
      // Buscar snapshot mas reciente del ad
      const snapshot = await MetricSnapshot.findOne({
        entity_type: 'ad',
        entity_id: proposal.meta_ad_id
      }).sort({ snapshot_at: -1 }).lean();

      if (!snapshot || !snapshot.metrics?.last_7d) continue;

      const m = snapshot.metrics.last_7d;
      if (m.spend <= 0) continue; // sin datos aun

      await CreativeProposal.findByIdAndUpdate(proposal._id, {
        $set: {
          'performance.roas_7d': m.roas || 0,
          'performance.spend_7d': m.spend || 0,
          'performance.purchases_7d': m.purchases || 0,
          'performance.ctr_7d': m.ctr || 0,
          'performance.measured_at': new Date()
        }
      });

      synced++;
    } catch (err) {
      logger.error(`[CREATIVE-AGENT] Sync error for proposal ${proposal._id}: ${err.message}`);
    }
  }

  // Actualizar ProductBank stats agregando metricas de todas las propuestas uploaded
  const products = await ProductBank.find({ active: true }).lean();
  let productsUpdated = 0;

  for (const product of products) {
    try {
      const proposals = await CreativeProposal.find({
        product_id: product._id,
        status: 'uploaded',
        'performance.measured_at': { $ne: null }
      }).lean();

      if (proposals.length === 0) continue;

      const totalSpend = proposals.reduce((s, p) => s + (p.performance?.spend_7d || 0), 0);
      const totalPurchases = proposals.reduce((s, p) => s + (p.performance?.purchases_7d || 0), 0);
      const withRoas = proposals.filter(p => p.performance?.roas_7d > 0);
      const avgRoas = withRoas.length > 0
        ? withRoas.reduce((s, p) => s + p.performance.roas_7d, 0) / withRoas.length
        : 0;

      // Calcular best/worst scene
      const sceneMap = {};
      for (const p of proposals) {
        if (!p.scene_short || !p.performance?.roas_7d) continue;
        if (!sceneMap[p.scene_short]) sceneMap[p.scene_short] = { roas: [], spend: 0, ads: 0 };
        sceneMap[p.scene_short].roas.push(p.performance.roas_7d);
        sceneMap[p.scene_short].spend += p.performance.spend_7d || 0;
        sceneMap[p.scene_short].ads++;
      }

      const sceneEntries = Object.entries(sceneMap).map(([scene, data]) => ({
        scene,
        avg_roas: data.roas.reduce((a, b) => a + b, 0) / data.roas.length,
        total_spend: data.spend,
        ads_created: data.ads
      }));
      sceneEntries.sort((a, b) => b.avg_roas - a.avg_roas);

      await ProductBank.findByIdAndUpdate(product._id, {
        $set: {
          'performance.total_spend': totalSpend,
          'performance.total_purchases': totalPurchases,
          'performance.avg_roas': Math.round(avgRoas * 100) / 100,
          'performance.best_scene': sceneEntries[0]?.scene || '',
          'performance.worst_scene': sceneEntries[sceneEntries.length - 1]?.scene || '',
          scene_performance: sceneEntries,
          updated_at: new Date()
        }
      });

      productsUpdated++;
    } catch (err) {
      logger.error(`[CREATIVE-AGENT] Product stats error for ${product.product_name}: ${err.message}`);
    }
  }

  logger.info(`[CREATIVE-AGENT] Performance sync: ${synced} propuestas actualizadas, ${productsUpdated} productos actualizados`);
  return { synced, products_updated: productsUpdated };
}

module.exports = { runCreativeAgent, approveProposal, rejectProposal, syncProposalPerformance, generateImage, generateCopy, uploadToMeta, SCENES };
