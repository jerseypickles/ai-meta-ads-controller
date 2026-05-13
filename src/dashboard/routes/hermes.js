const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const logger = require('../../utils/logger');
const HermesPhotoAsset = require('../../db/models/HermesPhotoAsset');
const HermesProposal = require('../../db/models/HermesProposal');
const HermesStoreVisit = require('../../db/models/HermesStoreVisit');
const offerRotator = require('../../ai/hermes/offer-rotator');
const config = require('../../../config');

// Multer config — memoria + 15MB cap (fotos pro pueden ser pesadas)
const photoUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo imágenes permitidas'));
  },
  limits: { fileSize: 15 * 1024 * 1024 }
});

// ═══════════════════════════════════════════════════════════════════════
// PHOTO BANK
// ═══════════════════════════════════════════════════════════════════════

/**
 * POST /api/hermes/photos/upload — sube foto al banco
 * Form fields: photo (file), tags (CSV), offer_types (CSV), product_id?, mood?, notes?
 */
router.post('/photos/upload', photoUpload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo file uploaded' });

    const { tags = '', offer_types = '', product_id, mood = '', notes = '' } = req.body;

    // Detectar dimensiones
    const meta = await sharp(req.file.buffer).metadata();

    const photo = await HermesPhotoAsset.create({
      filename: req.file.originalname,
      image_base64: req.file.buffer.toString('base64'),
      mime_type: req.file.mimetype,
      width: meta.width || 0,
      height: meta.height || 0,
      tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      offer_types: offer_types ? offer_types.split(',').map(t => t.trim()).filter(Boolean) : ['any'],
      product_id: product_id || null,
      mood,
      notes,
      uploaded_by: req.user?.username || 'user'
    });

    logger.info(`[HERMES-API] Photo uploaded: ${photo.filename} (${meta.width}x${meta.height}) — offers: ${photo.offer_types.join(',')}`);

    // Return sin el base64 para no inflar la response
    const { image_base64, ...photoLite } = photo.toObject();
    res.json({ photo: photoLite });
  } catch (err) {
    logger.error(`[HERMES-API] photos/upload failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/hermes/photos — lista fotos del banco (sin base64 para performance)
 */
router.get('/photos', async (req, res) => {
  try {
    const { active, offer_type, limit = 100 } = req.query;
    const query = {};
    if (active !== undefined) query.active = active === 'true';
    if (offer_type) query.offer_types = offer_type;

    const photos = await HermesPhotoAsset.find(query)
      .select('-image_base64')
      .sort({ uploaded_at: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json({ photos, count: photos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/hermes/photos/:id/image — devuelve la imagen base64 (para preview)
 */
router.get('/photos/:id/image', async (req, res) => {
  try {
    const photo = await HermesPhotoAsset.findById(req.params.id).select('image_base64 mime_type').lean();
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    if (!photo.image_base64) return res.status(404).json({ error: 'Photo has no base64 data (purged)' });

    res.set('Content-Type', photo.mime_type || 'image/jpeg');
    res.send(Buffer.from(photo.image_base64, 'base64'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/hermes/photos/:id — actualiza tags / offer_types / active / mood
 */
router.patch('/photos/:id', async (req, res) => {
  try {
    const allowedFields = ['tags', 'offer_types', 'active', 'archived', 'mood', 'notes', 'product_id'];
    const update = {};
    for (const f of allowedFields) {
      if (req.body[f] !== undefined) update[f] = req.body[f];
    }

    const photo = await HermesPhotoAsset.findByIdAndUpdate(req.params.id, update, { new: true })
      .select('-image_base64')
      .lean();

    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    res.json({ photo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/hermes/photos/:id — archive (soft delete)
 */
router.delete('/photos/:id', async (req, res) => {
  try {
    const photo = await HermesPhotoAsset.findByIdAndUpdate(
      req.params.id,
      { archived: true, active: false },
      { new: true }
    ).select('-image_base64').lean();

    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    res.json({ photo, archived: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PROPOSALS — approval queue
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/hermes/proposals — lista proposals (con composed_image_base64 para review visual)
 */
router.get('/proposals', async (req, res) => {
  try {
    const { status = 'pending', limit = 50 } = req.query;
    const query = status === 'all' ? {} : { status };
    const proposals = await HermesProposal.find(query)
      .sort({ generated_at: -1 })
      .limit(parseInt(limit))
      .populate('photo_asset_id', 'filename')
      .lean();

    res.json({ proposals, count: proposals.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/hermes/proposals/:id/image — preview de la composed image
 */
router.get('/proposals/:id/image', async (req, res) => {
  try {
    const proposal = await HermesProposal.findById(req.params.id).select('composed_image_base64').lean();
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (!proposal.composed_image_base64) return res.status(404).json({ error: 'No image data' });

    res.set('Content-Type', 'image/png');
    res.send(Buffer.from(proposal.composed_image_base64, 'base64'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/hermes/proposals/:id/approve
 */
router.post('/proposals/:id/approve', async (req, res) => {
  try {
    const { approveProposal } = require('../../ai/agent/hermes-agent');
    const proposal = await approveProposal(req.params.id, req.user?.username || 'user');
    res.json({ proposal });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/hermes/proposals/:id/reject
 */
router.post('/proposals/:id/reject', async (req, res) => {
  try {
    const { rejectProposal } = require('../../ai/agent/hermes-agent');
    const { reason = '' } = req.body;
    const proposal = await rejectProposal(req.params.id, reason, req.user?.username || 'user');
    res.json({ proposal });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/hermes/proposals/:id/publish
 *
 * Publica a Meta una proposal que ya está en status='approved' pero no
 * llegó a Meta (caso típico: aprobadas pre-Fase 2, o reintento después
 * de publish_failed). Idempotente: si ya tiene meta_ad_id, error.
 */
router.post('/proposals/:id/publish', async (req, res) => {
  try {
    const HermesProposal = require('../../db/models/HermesProposal');
    const proposal = await HermesProposal.findById(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (proposal.meta_ad_id) {
      return res.status(400).json({ error: `Proposal ya está publicada en Meta (ad_id: ${proposal.meta_ad_id})` });
    }
    if (proposal.status !== 'approved') {
      return res.status(400).json({ error: `Status es "${proposal.status}", debe ser "approved" para publicar` });
    }

    // Limpia el rejection_reason si era de publish_failed anterior
    if (proposal.rejection_reason?.startsWith('publish_failed')) {
      proposal.rejection_reason = '';
      await proposal.save();
    }

    const { publishProposalToMeta } = require('../../ai/hermes/meta-publisher');
    const result = await publishProposalToMeta(req.params.id);

    // Re-leer porque publisher actualiza
    const updated = await HermesProposal.findById(req.params.id);
    res.json({ proposal: updated, publish_result: result });
  } catch (err) {
    logger.error(`[HERMES-API] publish failed: ${err.message}`);
    // Persistir el error para audit
    try {
      const HermesProposal = require('../../db/models/HermesProposal');
      await HermesProposal.findByIdAndUpdate(req.params.id, {
        rejection_reason: `publish_failed: ${err.message}`
      });
    } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// STORE VISITS — log manual desde tienda
// ═══════════════════════════════════════════════════════════════════════

/**
 * POST /api/hermes/visits — log una visita
 * Body: source_offer (required), source_proposal_id?, converted_to_purchase?,
 *       purchase_amount?, customer_zip?, is_first_visit?, notes?
 */
router.post('/visits', async (req, res) => {
  try {
    const {
      source_offer,
      source_proposal_id,
      source_platform = 'unknown',
      converted_to_purchase = false,
      purchase_amount = 0,
      products_bought = [],
      customer_zip = '',
      is_first_visit = null,
      visitor_party_size = 1,
      notes = ''
    } = req.body;

    if (!source_offer) return res.status(400).json({ error: 'source_offer is required' });

    const visit = await HermesStoreVisit.create({
      source_offer,
      source_proposal_id: source_proposal_id || null,
      source_platform,
      converted_to_purchase,
      purchase_amount,
      products_bought,
      customer_zip,
      is_first_visit,
      visitor_party_size,
      notes,
      logged_by: req.user?.username || 'user'
    });

    logger.info(`[HERMES-API] Visit logged: offer=${source_offer}, converted=${converted_to_purchase}, $${purchase_amount}`);

    // Si está vinculada a una proposal, incrementar el counter en performance
    if (source_proposal_id) {
      await HermesProposal.findByIdAndUpdate(source_proposal_id, {
        $inc: { 'performance.manual_visits_reported': 1 }
      });
    }

    res.json({ visit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/hermes/visits — lista visitas recientes
 */
router.get('/visits', async (req, res) => {
  try {
    const { source_offer, days = 30, limit = 100 } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 86400000);
    const query = { visited_at: { $gte: since } };
    if (source_offer && source_offer !== 'all') query.source_offer = source_offer;

    const visits = await HermesStoreVisit.find(query)
      .sort({ visited_at: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json({ visits, count: visits.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// STATS + META
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/hermes/stats — agregados para dashboard
 */
router.get('/stats', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 86400000);

    const [photoCount, activePhotos, pendingProposals, livProposals, visitsByOffer] = await Promise.all([
      HermesPhotoAsset.countDocuments({ archived: false }),
      HermesPhotoAsset.countDocuments({ active: true, archived: false }),
      HermesProposal.countDocuments({ status: 'pending' }),
      HermesProposal.countDocuments({ status: 'live' }),
      HermesStoreVisit.aggregate([
        { $match: { visited_at: { $gte: since } } },
        {
          $group: {
            _id: '$source_offer',
            count: { $sum: 1 },
            converted: { $sum: { $cond: ['$converted_to_purchase', 1, 0] } },
            revenue: { $sum: '$purchase_amount' }
          }
        }
      ])
    ]);

    res.json({
      photos: { total: photoCount, active: activePhotos },
      proposals: { pending: pendingProposals, live: livProposals },
      visits: { window_days: parseInt(days), by_offer: visitsByOffer },
      config: {
        enabled: config.hermes?.enabled || false,
        mode: config.hermes?.mode || 'manual_approval',
        warehouse_address: config.hermes?.warehouseAddress || '',
        google_maps_url: config.hermes?.googleMapsUrl || ''
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/hermes/offers — lista las 3 ofertas + weights
 */
router.get('/offers', (req, res) => {
  res.json({ offers: offerRotator.listOffers() });
});

/**
 * POST /api/hermes/trigger-cycle — dispara un ciclo manual (dev/test only)
 */
router.post('/trigger-cycle', async (req, res) => {
  try {
    const { runHermesAgent } = require('../../ai/agent/hermes-agent');
    const result = await runHermesAgent();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/hermes/lookup-ids — auto-detecta Facebook Page ID + Instagram Business ID
 * usando el Meta access token ya configurado. Útil para setup inicial sin tener
 * que ir a Graph API Explorer manualmente.
 *
 * Devuelve los IDs + valores listos para copy-paste en env vars de Render.
 */
router.get('/lookup-ids', async (req, res) => {
  try {
    const { getMetaClient } = require('../../meta/client');
    const meta = getMetaClient();

    // Page ID — usa el helper que ya existe (extrae de ads)
    const pageId = await meta.getPageId();
    if (!pageId) {
      return res.status(404).json({
        error: 'No se pudo detectar Page ID. Asegúrate de tener al menos 1 ad creado en Meta Ads Manager.'
      });
    }

    // Page info + Instagram business account (1 call con field expansion)
    const pageInfo = await meta.get(`/${pageId}`, {
      fields: 'id,name,category,link,instagram_business_account{id,username,name}'
    });

    const igAccount = pageInfo.instagram_business_account || null;

    res.json({
      facebook: {
        page_id: pageInfo.id,
        page_name: pageInfo.name,
        category: pageInfo.category,
        url: pageInfo.link
      },
      instagram: igAccount ? {
        business_id: igAccount.id,
        username: igAccount.username,
        name: igAccount.name
      } : null,
      env_vars_for_render: {
        HERMES_FACEBOOK_PAGE_ID: pageInfo.id,
        HERMES_INSTAGRAM_ID: igAccount?.id || '(no Instagram Business linked — link in Meta Business Settings)'
      },
      hint: igAccount
        ? '✅ Both IDs found. Copy the env_vars_for_render to Render dashboard env settings.'
        : '⚠️ Instagram not linked to this Page. Go to Meta Business Settings → Instagram Accounts → link @jerseypickles.'
    });
  } catch (err) {
    const metaError = err.response?.data?.error;
    res.status(500).json({
      error: metaError?.message || err.message,
      meta_error_code: metaError?.code
    });
  }
});

module.exports = router;
