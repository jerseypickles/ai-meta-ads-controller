const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');
const CreativeAsset = require('../../db/models/CreativeAsset');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const { getMetaClient } = require('../../meta/client');
const logger = require('../../utils/logger');

const anthropic = new Anthropic({ apiKey: config.claude.apiKey });
const { generatePrompt } = require('../../ai/creative/prompt-generator');
const { generateImage, generateBatch, generateDualFormatBatch } = require('../../ai/creative/image-generator');
const { judgeImages } = require('../../ai/creative/image-judge');

// Configuración de multer para file upload
const UPLOAD_DIR = path.join(config.system.uploadsDir, 'creatives');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E6)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/quicktime', 'video/x-msvideo'
  ];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB máximo (para videos)
});

/**
 * Detect product name from image using Claude Vision.
 * Runs in background — non-blocking.
 */
async function detectProductFromImage(filePath, mimeType) {
  try {
    const imageData = fs.readFileSync(filePath);
    const base64 = imageData.toString('base64');
    const mediaType = mimeType === 'image/webp' ? 'image/png' : mimeType;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          {
            type: 'text',
            text: `Analyze this product/ad image. Return ONLY a JSON object with:
{
  "product_name": "full product name in English, 2-8 words (e.g. 'Hot Mild Pickle Salsa')",
  "product_line": "product category/line (e.g. 'Pickle Salsa', 'Pickles', 'Olives', 'Pickled Tomatoes'). If it's a jar/food product, identify the product LINE, not just 'food'.",
  "flavor": "specific flavor or variant (e.g. 'Regular Dill', 'Hot Mild', 'Sour', 'Garlic'). Read the jar label carefully for flavor/variant info. Empty string if not identifiable.",
  "product_type": "category like 'food', 'beauty', 'apparel', 'tech', 'home', 'other'"
}

IMPORTANT: Read the label text on the jar/packaging carefully to identify the EXACT product line and flavor/variant. For food products in jars, the label usually shows the brand, product line, and flavor.
If it's an ad creative (not a plain product photo), still identify the main product being advertised.
Return ONLY valid JSON, nothing else.`
          }
        ]
      }]
    });

    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      product_name: parsed.product_name || null,
      product_line: parsed.product_line || '',
      flavor: parsed.flavor || ''
    };
  } catch (error) {
    logger.error(`[PRODUCT-DETECT] Error detecting product: ${error.message}`);
    return null;
  }
}

/**
 * POST /api/creatives/upload
 * Subir un creative (imagen o video) con metadata.
 * Si es imagen, Claude Vision detecta el producto automáticamente en background.
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió archivo' });
    }

    const mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';

    const asset = await CreativeAsset.create({
      filename: req.file.filename,
      original_name: req.file.originalname,
      file_path: req.file.path,
      file_type: req.file.mimetype,
      media_type: mediaType,
      purpose: ['ad-ready', 'reference'].includes(req.body.purpose) ? req.body.purpose : 'ad-ready',
      style: ['ugly-ad', 'polished', 'ugc', 'meme', 'other'].includes(req.body.style) ? req.body.style : 'other',
      ad_format: ['feed', 'stories'].includes(req.body.ad_format) ? req.body.ad_format : '',
      headline: req.body.headline || '',
      body: req.body.body || '',
      description: req.body.description || '',
      cta: req.body.cta || 'SHOP_NOW',
      link_url: req.body.link_url || '',
      product_name: req.body.product_name || '',
      product_line: req.body.product_line || '',
      flavor: req.body.flavor || '',
      tags: req.body.tags ? JSON.parse(req.body.tags) : [],
      notes: req.body.notes || ''
    });

    logger.info(`Creative subido: ${req.file.originalname} (${mediaType})`);

    // AI product detection — only for images without manual product_name
    if (mediaType === 'image' && !req.body.product_name) {
      const isReference = asset.purpose === 'reference';
      if (isReference) {
        // BLOCKING for reference/product images — we need the name immediately
        try {
          const detected = await detectProductFromImage(req.file.path, req.file.mimetype);
          if (detected?.product_name) {
            asset.product_name = detected.product_name;
            asset.product_line = detected.product_line || '';
            asset.flavor = detected.flavor || '';
            asset.product_detected_by = 'ai';
            await asset.save();
            logger.info(`[PRODUCT-DETECT] "${detected.product_name}" (linea: ${detected.product_line}, sabor: ${detected.flavor}) detectado para ${req.file.originalname} (blocking)`);
          }
        } catch (e) {
          logger.warn(`[PRODUCT-DETECT] No se pudo detectar producto para ${req.file.originalname}: ${e.message}`);
        }
      } else {
        // Non-blocking for ad-ready images
        detectProductFromImage(req.file.path, req.file.mimetype).then(async (detected) => {
          if (detected?.product_name) {
            await CreativeAsset.findByIdAndUpdate(asset._id, {
              product_name: detected.product_name,
              product_line: detected.product_line || '',
              flavor: detected.flavor || '',
              product_detected_by: 'ai'
            });
            logger.info(`[PRODUCT-DETECT] "${detected.product_name}" (linea: ${detected.product_line}, sabor: ${detected.flavor}) detectado para ${req.file.originalname}`);
          }
        }).catch(() => {});
      }
    }

    res.json({ success: true, asset });
  } catch (error) {
    // Limpiar archivo si hubo error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    logger.error(`Error subiendo creative: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/creatives
 * Listar banco de creativos con info de ad sets donde se usan.
 */
router.get('/', async (req, res) => {
  try {
    const { status = 'active', limit = 50, purpose, style } = req.query;
    const filter = status === 'all' ? {} : { status };
    if (purpose) filter.purpose = purpose;
    if (style) filter.style = style;

    const assets = await CreativeAsset.find(filter)
      .sort({ created_at: -1 })
      .limit(parseInt(limit))
      .lean();

    // Enrich with ad set names from AICreation records
    const AICreation = require('../../db/models/AICreation');
    const allAdSetIds = [...new Set(assets.flatMap(a => a.used_in_adsets || []))];
    let adSetMap = {};
    if (allAdSetIds.length > 0) {
      const aiCreations = await AICreation.find({
        meta_entity_id: { $in: allAdSetIds }
      }).select('meta_entity_id meta_entity_name lifecycle_phase current_status').lean();
      for (const ac of aiCreations) {
        adSetMap[ac.meta_entity_id] = {
          name: ac.meta_entity_name,
          phase: ac.lifecycle_phase,
          status: ac.current_status
        };
      }
    }

    const enriched = assets.map(a => ({
      ...a,
      adset_usage: (a.used_in_adsets || []).map(id => ({
        adset_id: id,
        ...(adSetMap[id] || { name: id, phase: 'unknown', status: 'UNKNOWN' })
      }))
    }));

    res.json({ assets: enriched, total: enriched.length });
  } catch (error) {
    logger.error(`Error listando creativos: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/creatives/detect-all
 * Re-detectar product_line y flavor en todos los assets de imagen que no los tengan.
 * Procesa secuencialmente para no saturar la API de Claude.
 * MUST be before /:id routes to avoid Express matching "detect-all" as an :id param.
 */
router.post('/detect-all', async (req, res) => {
  try {
    const assets = await CreativeAsset.find({
      status: 'active',
      media_type: 'image',
      $or: [
        { product_line: { $in: ['', null] } },
        { flavor: { $in: ['', null] } }
      ]
    }).lean();

    if (assets.length === 0) {
      return res.json({ success: true, message: 'Todos los assets ya tienen product_line y flavor', updated: 0, total: 0 });
    }

    logger.info(`[PRODUCT-DETECT] Bulk re-detect: ${assets.length} assets sin product_line/flavor`);

    let updated = 0;
    let errors = 0;
    const results = [];

    for (const asset of assets) {
      if (!asset.file_path || !fs.existsSync(asset.file_path)) {
        results.push({ id: asset._id, name: asset.original_name, error: 'Archivo no encontrado' });
        errors++;
        continue;
      }

      try {
        const detected = await detectProductFromImage(asset.file_path, asset.file_type);
        if (detected?.product_name) {
          await CreativeAsset.findByIdAndUpdate(asset._id, {
            product_name: detected.product_name,
            product_line: detected.product_line || '',
            flavor: detected.flavor || '',
            product_detected_by: 'ai',
            updated_at: new Date()
          });
          updated++;
          results.push({ id: asset._id, name: asset.original_name, product_name: detected.product_name, product_line: detected.product_line, flavor: detected.flavor });
          logger.info(`[PRODUCT-DETECT] Bulk: "${detected.product_name}" | ${detected.product_line} | ${detected.flavor} -> ${asset.original_name}`);
        } else {
          results.push({ id: asset._id, name: asset.original_name, error: 'No detectado' });
          errors++;
        }
      } catch (e) {
        results.push({ id: asset._id, name: asset.original_name, error: e.message });
        errors++;
      }
    }

    logger.info(`[PRODUCT-DETECT] Bulk completado: ${updated}/${assets.length} actualizados, ${errors} errores`);
    res.json({ success: true, total: assets.length, updated, errors, results });
  } catch (error) {
    logger.error(`[PRODUCT-DETECT] Error en bulk detect: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CREATIVE PERFORMANCE SYNC (before /:id routes)
// ============================================

/**
 * Sincronizar métricas de rendimiento de creativos desde ad snapshots.
 * Two-phase approach:
 *   Phase 1: Discover ad-creative links from Meta API for creatives missing used_in_ads
 *   Phase 2: For creatives with used_in_ads, pull MetricSnapshot data and compute weighted avg CTR/ROAS
 */
async function syncCreativeMetrics() {
  const meta = getMetaClient();
  let discovered = 0;

  // Phase 1: Discover ad-creative links for creatives that have been uploaded to Meta but lack used_in_ads
  try {
    const uploadedCreatives = await CreativeAsset.find({
      status: 'active',
      uploaded_to_meta: true,
      $or: [
        { used_in_ads: { $exists: false } },
        { used_in_ads: { $size: 0 } }
      ]
    });

    if (uploadedCreatives.length > 0) {
      // Build image_hash → creative lookup
      const hashToCreative = {};
      for (const c of uploadedCreatives) {
        if (c.meta_image_hash) hashToCreative[c.meta_image_hash] = c;
      }

      if (Object.keys(hashToCreative).length > 0) {
        // Fetch all active/paused ads from the account
        try {
          const adsData = await meta.get(`/${meta.adAccountId}/ads`, {
            fields: 'id,name,status,adset_id,creative{id,image_hash,object_story_spec}',
            filtering: JSON.stringify([{
              field: 'effective_status',
              operator: 'IN',
              value: ['ACTIVE', 'PAUSED']
            }]),
            limit: 200
          });

          const ads = adsData?.data || [];
          for (const ad of ads) {
            const imgHash = ad.creative?.image_hash;
            if (imgHash && hashToCreative[imgHash]) {
              const creative = hashToCreative[imgHash];
              if (!creative.used_in_ads) creative.used_in_ads = [];
              if (!creative.used_in_ads.includes(ad.id)) {
                creative.used_in_ads.push(ad.id);
              }
              if (!creative.used_in_adsets) creative.used_in_adsets = [];
              if (ad.adset_id && !creative.used_in_adsets.includes(ad.adset_id)) {
                creative.used_in_adsets.push(ad.adset_id);
              }
              creative.times_used = creative.used_in_ads.length;
              creative.updated_at = new Date();
              await creative.save();
              discovered++;
            }
          }

          if (discovered > 0) {
            logger.info(`[CREATIVE-SYNC] Discovered ${discovered} ad-creative links from Meta API`);
          }
        } catch (apiErr) {
          logger.warn(`[CREATIVE-SYNC] Could not fetch ads for discovery: ${apiErr.message}`);
        }
      }
    }
  } catch (discoverErr) {
    logger.warn(`[CREATIVE-SYNC] Discovery phase error: ${discoverErr.message}`);
  }

  // Phase 2: Sync metrics for creatives that have used_in_ads
  const creatives = await CreativeAsset.find({
    status: 'active',
    'used_in_ads.0': { $exists: true }
  });

  if (creatives.length === 0) {
    return { synced: 0, skipped: 0, discovered };
  }

  // Collect all ad IDs we need snapshots for
  const allAdIds = new Set();
  for (const c of creatives) {
    for (const adId of (c.used_in_ads || [])) {
      allAdIds.add(adId);
    }
  }

  // Batch fetch latest snapshots for all ads (1 aggregation query)
  const adSnapshots = await MetricSnapshot.aggregate([
    { $match: { entity_type: 'ad', entity_id: { $in: [...allAdIds] } } },
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } }
  ]);

  // Build lookup map: ad_id → snapshot
  const snapshotMap = {};
  for (const snap of adSnapshots) {
    snapshotMap[snap.entity_id] = snap;
  }

  let synced = 0;
  let skipped = 0;

  for (const creative of creatives) {
    const adIds = creative.used_in_ads || [];
    if (adIds.length === 0) { skipped++; continue; }

    let totalSpend = 0;
    let weightedCtr = 0;
    let weightedRoas = 0;

    for (const adId of adIds) {
      const snap = snapshotMap[adId];
      if (!snap) continue;

      const m = snap.metrics?.last_7d || snap.metrics?.last_3d || {};
      const spend = m.spend || 0;

      if (spend > 0) {
        totalSpend += spend;
        weightedCtr += (m.ctr || 0) * spend;
        weightedRoas += (m.roas || 0) * spend;
      }
    }

    if (totalSpend > 0) {
      creative.avg_ctr = Math.round((weightedCtr / totalSpend) * 100) / 100;
      creative.avg_roas = Math.round((weightedRoas / totalSpend) * 100) / 100;
      creative.updated_at = new Date();
      await creative.save();
      synced++;
    } else {
      skipped++;
    }
  }

  return { synced, skipped, discovered, total_creatives: creatives.length, ads_with_snapshots: adSnapshots.length };
}

// POST /api/creatives/sync-metrics — MUST be before /:id routes
router.post('/sync-metrics', async (req, res) => {
  try {
    logger.info('[CREATIVE-SYNC] Iniciando sincronización de métricas de creativos...');
    const result = await syncCreativeMetrics();
    logger.info(`[CREATIVE-SYNC] Completado: ${result.synced} sincronizados, ${result.skipped} sin datos, ${result.discovered} descubiertos`);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error(`[CREATIVE-SYNC] Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/creatives/:id
 * Obtener un creative específico.
 */
router.get('/:id', async (req, res) => {
  try {
    const asset = await CreativeAsset.findById(req.params.id).lean();
    if (!asset) return res.status(404).json({ error: 'Creative no encontrado' });
    res.json(asset);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/creatives/:id
 * Actualizar metadata de un creative.
 */
router.put('/:id', async (req, res) => {
  try {
    const updates = {};
    const allowedFields = ['headline', 'body', 'description', 'cta', 'link_url', 'tags', 'notes', 'purpose', 'style', 'product_name', 'product_line', 'flavor', 'ad_format'];
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        if (field === 'tags' && typeof req.body[field] === 'string') {
          updates[field] = JSON.parse(req.body[field]);
        } else {
          updates[field] = req.body[field];
        }
      }
    }
    updates.updated_at = new Date();

    const asset = await CreativeAsset.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!asset) return res.status(404).json({ error: 'Creative no encontrado' });

    res.json({ success: true, asset });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/creatives/:id/detect-product
 * Forzar detección de producto con Claude Vision.
 */
router.post('/:id/detect-product', async (req, res) => {
  try {
    const asset = await CreativeAsset.findById(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Creative no encontrado' });
    if (asset.media_type !== 'image') return res.status(400).json({ error: 'Solo soporta imágenes' });
    if (!fs.existsSync(asset.file_path)) return res.status(400).json({ error: 'Archivo no encontrado' });

    const detected = await detectProductFromImage(asset.file_path, asset.file_type);
    if (detected?.product_name) {
      asset.product_name = detected.product_name;
      asset.product_line = detected.product_line || '';
      asset.flavor = detected.flavor || '';
      asset.product_detected_by = 'ai';
      asset.updated_at = new Date();
      await asset.save();
      res.json({ success: true, product_name: detected.product_name, product_line: detected.product_line, flavor: detected.flavor });
    } else {
      res.json({ success: false, message: 'No se pudo detectar producto' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/creatives/:id/upload-to-meta
 * Subir asset a Meta Ads y guardar image_hash/video_id.
 */
router.post('/:id/upload-to-meta', async (req, res) => {
  try {
    const asset = await CreativeAsset.findById(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Creative no encontrado' });

    if (asset.uploaded_to_meta) {
      return res.json({
        success: true,
        already_uploaded: true,
        image_hash: asset.meta_image_hash,
        video_id: asset.meta_video_id
      });
    }

    if (!fs.existsSync(asset.file_path)) {
      return res.status(400).json({ error: 'Archivo no encontrado en disco' });
    }

    const meta = getMetaClient();

    if (asset.media_type === 'image') {
      const result = await meta.uploadImage(asset.file_path);
      asset.meta_image_hash = result.image_hash;
    } else if (asset.media_type === 'video') {
      const result = await meta.uploadVideo(asset.file_path);
      asset.meta_video_id = result.video_id;
    }

    asset.uploaded_to_meta = true;
    asset.uploaded_at = new Date();
    await asset.save();

    logger.info(`Creative ${asset.original_name} subido a Meta`);
    res.json({
      success: true,
      image_hash: asset.meta_image_hash,
      video_id: asset.meta_video_id
    });
  } catch (error) {
    logger.error(`Error subiendo creative a Meta: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/creatives/:id
 * Eliminar un creative permanentemente (archivo + DB).
 */
router.delete('/:id', async (req, res) => {
  try {
    const asset = await CreativeAsset.findById(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Creative no encontrado' });

    // Borrar archivo de disco
    if (asset.file_path && fs.existsSync(asset.file_path)) {
      fs.unlinkSync(asset.file_path);
    }

    // Borrar de DB
    await CreativeAsset.findByIdAndDelete(req.params.id);

    logger.info(`Creative eliminado: ${asset.original_name}`);
    res.json({ success: true, deleted: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/creatives/:id/preview
 * Servir archivo de creative para preview en frontend.
 */
router.get('/:id/preview', async (req, res) => {
  try {
    const asset = await CreativeAsset.findById(req.params.id).lean();
    if (!asset) return res.status(404).json({ error: 'Creative no encontrado' });

    if (!fs.existsSync(asset.file_path)) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }

    res.sendFile(asset.file_path);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/creatives/generate/prompt
 * Paso 1: Claude genera el prompt optimizado basado en estilo y producto.
 */
router.post('/generate/prompt', async (req, res) => {
  try {
    const { style = 'ugly-ad', format = 'feed', userInstruction = '', productId, referenceIds = [] } = req.body;

    // Get product info — prefer product_name (AI-detected or manual), fallback to headline
    let productName = '';
    let productDescription = '';
    let productImagePath = '';
    if (productId) {
      const product = await CreativeAsset.findById(productId).lean();
      if (product) {
        productName = product.product_name || product.headline || product.original_name;
        productDescription = product.notes || product.description || '';
        if (product.file_path && fs.existsSync(product.file_path)) {
          productImagePath = product.file_path;
        }
      }
    }

    // Get reference assets for creative direction
    let referenceAssets = [];
    if (referenceIds.length > 0) {
      // Use user-selected references
      referenceAssets = await CreativeAsset.find({
        _id: { $in: referenceIds },
        status: 'active'
      }).lean();
    } else {
      // Fall back to all reference assets matching the style
      referenceAssets = await CreativeAsset.find({
        status: 'active',
        purpose: 'reference',
        ...(style !== 'other' ? { style } : {})
      }).sort({ avg_roas: -1 }).limit(5).lean();
    }

    // Aggregate style performance data from all assets
    const styleData = await CreativeAsset.aggregate([
      { $match: { status: 'active', style: { $ne: 'other' } } },
      { $group: {
        _id: '$style',
        count: { $sum: 1 },
        avg_roas: { $avg: '$avg_roas' },
        avg_ctr: { $avg: '$avg_ctr' }
      }},
      { $project: { style: '$_id', count: 1, avg_roas: 1, avg_ctr: 1, _id: 0 } }
    ]);

    // === TOP PERFORMERS: best-performing creatives of the same style as visual inspiration ===
    const topPerformers = await CreativeAsset.find({
      status: 'active',
      purpose: 'ad-ready',
      media_type: 'image',
      style,
      avg_roas: { $gt: 0 },
      times_used: { $gte: 1 }
    }).sort({ avg_roas: -1 }).limit(3).lean();

    // === SCENE PERFORMANCE: which scene_labels have the best results ===
    const scenePerformance = await CreativeAsset.aggregate([
      { $match: {
        status: 'active',
        purpose: 'ad-ready',
        style,
        scene_label: { $nin: [null, ''] },
        times_used: { $gte: 1 },
        avg_roas: { $gt: 0 }
      }},
      { $group: {
        _id: '$scene_label',
        count: { $sum: 1 },
        avg_roas: { $avg: '$avg_roas' },
        avg_ctr: { $avg: '$avg_ctr' },
        total_used: { $sum: '$times_used' }
      }},
      { $sort: { avg_roas: -1 } },
      { $limit: 10 },
      { $project: { scene_label: '$_id', count: 1, avg_roas: 1, avg_ctr: 1, total_used: 1, _id: 0 } }
    ]);

    const result = await generatePrompt({
      style, format, userInstruction, productName, productDescription,
      styleData, referenceAssets, productImagePath, topPerformers, scenePerformance
    });
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error(`Error generando prompt creativo: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/creatives/generate/images
 * Paso 2: Genera imagenes con OpenAI — dual format (3 escenas × 2 formatos = 6 imagenes).
 */
router.post('/generate/images', async (req, res) => {
  try {
    const { prompts, format = 'feed', productId } = req.body;
    if (!prompts || !Array.isArray(prompts) || prompts.length === 0) {
      return res.status(400).json({ error: 'Se requiere array de prompts' });
    }
    if (!productId) return res.status(400).json({ error: 'Se requiere productId' });

    // Get product image path
    const product = await CreativeAsset.findById(productId).lean();
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
    if (!fs.existsSync(product.file_path)) {
      return res.status(400).json({ error: 'Archivo de producto no encontrado en disco' });
    }

    // Use dual-format batch: each prompt generates both 1:1 and 9:16
    const results = await generateDualFormatBatch(prompts, product.file_path);

    const images = results.map(r => {
      if (r.error) return { error: r.error, scene_label: r.scene_label, ad_format: r.ad_format };
      return {
        filename: r.filename,
        scene_label: r.scene_label,
        ad_format: r.ad_format,
        model: r.model,
        generation_time_s: r.generation_time_s,
        size_bytes: r.size_bytes,
        prompt: r.prompt
      };
    });

    const successCount = images.filter(i => !i.error).length;

    res.json({
      success: true,
      dual_format: true,
      total: images.length,
      success_count: successCount,
      images
    });
  } catch (error) {
    logger.error(`Error generando imagenes: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/creatives/generate/preview/:filename
 * Servir imagen generada para preview en frontend.
 */
router.get('/generate/preview/:filename', (req, res) => {
  const GENERATED_DIR = path.join(__dirname, '../../../uploads/generated');
  const filePath = path.join(GENERATED_DIR, req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Imagen no encontrada' });
  }

  res.sendFile(filePath);
});

/**
 * POST /api/creatives/generate/accept
 * Paso 3: Aceptar una imagen generada y guardarla en el banco creativo.
 */
router.post('/generate/accept', async (req, res) => {
  try {
    const {
      filename, prompt, style = 'other', format = 'feed', ad_format,
      headline = '', productId = null, suggested_headline = '', suggested_body = ''
    } = req.body;
    // ad_format comes from dual-format generation (feed/stories), fallback to format
    const resolvedFormat = ad_format || format;

    if (!filename) {
      return res.status(400).json({ error: 'Se requiere filename' });
    }

    const GENERATED_DIR = path.join(__dirname, '../../../uploads/generated');
    const sourcePath = path.join(GENERATED_DIR, filename);
    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: 'Imagen generada no encontrada' });
    }

    // Move to creatives upload dir
    const UPLOAD_DIR = path.join(__dirname, '../../../uploads/creatives');
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    const newFilename = `gen-openai-${Date.now()}.png`;
    const destPath = path.join(UPLOAD_DIR, newFilename);
    fs.copyFileSync(sourcePath, destPath);

    // Inherit product info from source product if available
    let inheritedProductName = '';
    let inheritedProductLine = '';
    let inheritedFlavor = '';
    if (productId) {
      try {
        const sourceProduct = await CreativeAsset.findById(productId).lean();
        if (sourceProduct?.product_name) {
          inheritedProductName = sourceProduct.product_name;
          inheritedProductLine = sourceProduct.product_line || '';
          inheritedFlavor = sourceProduct.flavor || '';
        }
      } catch (e) { /* ok */ }
    }

    // Check if there's a paired asset (same scene_label, opposite format, from same batch)
    const sceneLabel = req.body.scene_label || '';
    let pairedId = null;
    if (sceneLabel && productId) {
      const oppositeFormat = resolvedFormat === 'feed' ? 'stories' : 'feed';
      const paired = await CreativeAsset.findOne({
        generated_by: 'openai',
        reference_asset_ids: productId,
        ad_format: oppositeFormat,
        tags: { $all: ['ai-generated', sceneLabel] },
        paired_asset_id: null,
        status: 'active'
      }).sort({ created_at: -1 }).lean();
      if (paired) pairedId = paired._id;
    }

    // Create asset in DB
    const asset = await CreativeAsset.create({
      filename: newFilename,
      original_name: headline || 'AI Generated (OpenAI)',
      file_path: destPath,
      file_type: 'image/png',
      media_type: 'image',
      purpose: 'ad-ready',
      style,
      generated_by: 'openai',
      generation_prompt: prompt,
      scene_label: sceneLabel || null,
      reference_asset_ids: productId ? [productId] : [],
      headline: suggested_headline || headline || 'AI Creative - OpenAI',
      body: suggested_body || '',
      cta: 'SHOP_NOW',
      ad_format: resolvedFormat,
      product_name: inheritedProductName,
      product_line: inheritedProductLine,
      flavor: inheritedFlavor,
      product_detected_by: inheritedProductName ? 'ai' : '',
      paired_asset_id: pairedId,
      tags: ['ai-generated', style, resolvedFormat, ...(sceneLabel ? [sceneLabel] : [])]
    });

    // Link the paired asset back to this one
    if (pairedId) {
      await CreativeAsset.findByIdAndUpdate(pairedId, { paired_asset_id: asset._id });
    }

    // Don't delete source file — other images from the same batch may still need preview/accept
    // Generated files are cleaned up when user closes the modal or on next batch generation

    // AI product detection in background — only if we didn't inherit product_name
    if (!inheritedProductName) {
      detectProductFromImage(destPath, 'image/png').then(async (detected) => {
        if (detected?.product_name) {
          await CreativeAsset.findByIdAndUpdate(asset._id, {
            product_name: detected.product_name,
            product_line: detected.product_line || '',
            flavor: detected.flavor || '',
            product_detected_by: 'ai'
          });
          logger.info(`[PRODUCT-DETECT] "${detected.product_name}" (linea: ${detected.product_line}, sabor: ${detected.flavor}) detectado para ${newFilename}`);
        }
      }).catch(() => {});
    }

    logger.info(`Creative IA aceptado: openai -> ${newFilename}`);
    res.json({ success: true, asset });
  } catch (error) {
    logger.error(`Error aceptando creative generado: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/creatives/generate/judge
 * Paso 2.5: Claude Vision analiza las imagenes generadas y las rankea por CTR potencial.
 */
router.post('/generate/judge', async (req, res) => {
  try {
    const { images, style = 'ugly-ad', format = 'feed' } = req.body;
    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'Se requiere array de imagenes' });
    }

    // Add originalIndex to track position
    const imagesWithIndex = images.map((img, i) => ({ ...img, originalIndex: i }));

    const result = await judgeImages(imagesWithIndex, style, format);

    logger.info(`[JUDGE] ${result.images_judged} imagenes juzgadas en ${result.judge_time_s}s`);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error(`Error juzgando imagenes: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.syncCreativeMetrics = syncCreativeMetrics;
module.exports = router;
