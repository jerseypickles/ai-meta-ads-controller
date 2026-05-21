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
    const { status = 'pending', limit = 50, include_image = 'false' } = req.query;
    const query = status === 'all' ? {} : { status };

    // Por default EXCLUIR composed_image_base64 (~1-3MB cada uno → con
    // status=all+limit=200 hace 32MB+ de response). La imagen se sirve via
    // endpoint dedicado /proposals/:id/image. Pasar include_image=true para
    // incluirla inline (raro, casi nunca necesario).
    const select = include_image === 'true'
      ? undefined
      : '-composed_image_base64 -composed_image_story_base64 -overlay_config.generated_image_prompt';

    let q = HermesProposal.find(query)
      .sort({ generated_at: -1 })
      .limit(parseInt(limit))
      .populate('photo_asset_id', 'filename');

    if (select) q = q.select(select);
    const proposals = await q.lean();

    res.json({ proposals, count: proposals.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/hermes/proposals/:id/image — preview del creative Feed (2:3)
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
 * GET /api/hermes/proposals/:id/image-story — preview del creative Story/Reel (9:16)
 * Fallback al Feed image si el proposal es pre-refactor (sin story version).
 */
router.get('/proposals/:id/image-story', async (req, res) => {
  try {
    const proposal = await HermesProposal.findById(req.params.id)
      .select('composed_image_story_base64 composed_image_base64').lean();
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    const data = proposal.composed_image_story_base64 || proposal.composed_image_base64;
    if (!data) return res.status(404).json({ error: 'No image data' });

    res.set('Content-Type', 'image/png');
    res.send(Buffer.from(data, 'base64'));
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
 * POST /api/hermes/proposals/:id/sync-metrics
 *
 * Pull metrics actuales del ad de Meta y persistir en HermesProposal.performance.
 * Devuelve también raw_meta_data para inspección.
 */
router.post('/proposals/:id/sync-metrics', async (req, res) => {
  try {
    const { syncProposalMetricsFromMeta } = require('../../ai/hermes/meta-publisher');
    const result = await syncProposalMetricsFromMeta(req.params.id);
    res.json(result);
  } catch (err) {
    logger.error(`[HERMES-API] sync-metrics failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/hermes/sync-all-metrics
 *
 * Pull metrics para TODOS los proposals live (meta_ad_id presente).
 * Útil para refresh masivo on-demand. Eventualmente lo va a llamar el cron diario.
 */
router.post('/sync-all-metrics', async (req, res) => {
  try {
    const HermesProposal = require('../../db/models/HermesProposal');
    const { syncProposalMetricsFromMeta } = require('../../ai/hermes/meta-publisher');

    const liveProposals = await HermesProposal.find({
      meta_ad_id: { $exists: true, $ne: null }
    }).select('_id meta_ad_id offer_type').lean();

    const results = [];
    for (const p of liveProposals) {
      try {
        const r = await syncProposalMetricsFromMeta(p._id);
        results.push({ proposal_id: p._id, offer_type: p.offer_type, meta_ad_id: p.meta_ad_id, ...r });
      } catch (err) {
        results.push({ proposal_id: p._id, error: err.message });
      }
    }
    res.json({ synced: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/hermes/update-adset-targeting
 *
 * Actualiza el targeting del adset existente de Hermes a Tri-state regions
 * (NJ+NY+PA) + Feed-only placements. Útil para migrar adsets creados antes
 * del fix de targeting sin tener que archivarlos y recrear.
 */
router.post('/update-adset-targeting', async (req, res) => {
  try {
    const { updateExistingAdsetTargeting } = require('../../ai/hermes/meta-publisher');
    const result = await updateExistingAdsetTargeting();
    res.json(result);
  } catch (err) {
    logger.error(`[HERMES-API] update-adset-targeting failed: ${err.message}`);
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

    // Current config (lo que el running process tiene seteado AHORA)
    const currentFbPageId = process.env.HERMES_FACEBOOK_PAGE_ID || config.hermes?.facebookPageId || null;
    const currentIgId = process.env.HERMES_INSTAGRAM_ID || config.hermes?.instagramId || null;

    // Verificación: ¿el IG ID seteado matches con el detected del Page?
    const igMatch = currentIgId && igAccount && currentIgId === igAccount.id;
    const fbMatch = currentFbPageId && currentFbPageId === pageInfo.id;

    // Si hay IG ID seteado pero NO matches con el del Page → verificación independiente
    // (lookup directo del ID seteado para ver a quién pertenece)
    let currentIgInfo = null;
    if (currentIgId && !igMatch) {
      try {
        currentIgInfo = await meta.get(`/${currentIgId}`, { fields: 'id,username,name' });
      } catch (lookupErr) {
        currentIgInfo = { error: lookupErr.response?.data?.error?.message || lookupErr.message };
      }
    }

    res.json({
      detected_from_page: {
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
        } : null
      },
      current_config: {
        HERMES_FACEBOOK_PAGE_ID: currentFbPageId || '(not set — using auto-detect)',
        HERMES_INSTAGRAM_ID: currentIgId || '(not set — ads will run Facebook only)',
        facebook_matches_detected: fbMatch,
        instagram_matches_detected: igMatch,
        current_instagram_owner: currentIgInfo
      },
      env_vars_for_render: {
        HERMES_FACEBOOK_PAGE_ID: pageInfo.id,
        HERMES_INSTAGRAM_ID: igAccount?.id || '(no Instagram Business linked — link in Meta Business Settings)'
      },
      verification: {
        facebook_ok: !currentFbPageId || fbMatch,
        instagram_ok: !currentIgId || igMatch,
        all_ok: (!currentFbPageId || fbMatch) && (!currentIgId || igMatch)
      },
      hint: !igAccount
        ? '⚠️ Instagram not linked to this Page. Go to Meta Business Settings → Instagram Accounts → link @jerseypickles.'
        : (igMatch && fbMatch)
          ? '✅ Current config matches detected IDs from Page. Both IG + FB serving correctly.'
          : (currentIgId && !igMatch)
            ? `🚨 MISMATCH: HERMES_INSTAGRAM_ID is set to ${currentIgId} but Page is linked to ${igAccount.id} (@${igAccount.username}). Ads may be serving under wrong IG account!`
            : 'ℹ️ Copy env_vars_for_render values to Render env settings to enable IG serving.'
    });
  } catch (err) {
    const metaError = err.response?.data?.error;
    res.status(500).json({
      error: metaError?.message || err.message,
      meta_error_code: metaError?.code
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// REFERENCES — imágenes que Hermes pasa a gpt-image-2 como ancla visual
// ═══════════════════════════════════════════════════════════════════════

const HermesReference = require('../../db/models/HermesReference');

const VALID_OFFER_MATCH = [
  'any', 'free_chamoy', 'free_tajin', 'free_olive_flight', 'free_olive',
  'free_pickle_flight', 'free_big_dill', 'free_pickle_juice'
];

/**
 * POST /api/hermes/references/upload — sube imagen de referencia
 * Form fields: image (file), offer_match (CSV), purpose, notes
 */
router.post('/references/upload', photoUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });

    const { offer_match = 'any', purpose = 'product', notes = '' } = req.body;

    // Normalizar a PNG para input consistente a gpt-image-2
    const pngBuffer = await sharp(req.file.buffer).png().toBuffer();
    const meta = await sharp(pngBuffer).metadata();

    const matchList = offer_match
      .split(',')
      .map(s => s.trim())
      .filter(s => VALID_OFFER_MATCH.includes(s));

    const reference = await HermesReference.create({
      filename: req.file.originalname,
      image_base64: pngBuffer.toString('base64'),
      mime_type: 'image/png',
      width: meta.width || 0,
      height: meta.height || 0,
      offer_match: matchList.length ? matchList : ['any'],
      purpose: ['product', 'style', 'color'].includes(purpose) ? purpose : 'product',
      notes,
      uploaded_by: req.user?.username || 'user'
    });

    logger.info(`[HERMES-API] Reference uploaded: ${reference.filename} (${meta.width}x${meta.height}) — match: ${reference.offer_match.join(',')} purpose: ${reference.purpose}`);

    const { image_base64, ...lite } = reference.toObject();
    res.json({ reference: lite });
  } catch (err) {
    logger.error(`[HERMES-API] references/upload failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/hermes/references — lista referencias (sin base64)
 */
router.get('/references', async (req, res) => {
  try {
    const { active } = req.query;
    const query = {};
    if (active !== undefined) query.active = active === 'true';

    const references = await HermesReference.find(query)
      .select('-image_base64')
      .sort({ uploaded_at: -1 })
      .lean();

    res.json({ references, count: references.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/hermes/references/:id/image — preview de la referencia
 */
router.get('/references/:id/image', async (req, res) => {
  try {
    const ref = await HermesReference.findById(req.params.id).select('image_base64 mime_type').lean();
    if (!ref || !ref.image_base64) return res.status(404).json({ error: 'Reference not found' });

    res.set('Content-Type', ref.mime_type || 'image/png');
    res.send(Buffer.from(ref.image_base64, 'base64'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/hermes/references/:id — actualiza offer_match / purpose / active / notes
 */
router.patch('/references/:id', async (req, res) => {
  try {
    const update = {};
    if (req.body.active !== undefined) update.active = req.body.active;
    if (req.body.notes !== undefined) update.notes = req.body.notes;
    if (req.body.purpose && ['product', 'style', 'color'].includes(req.body.purpose)) {
      update.purpose = req.body.purpose;
    }
    if (req.body.offer_match !== undefined) {
      const list = (Array.isArray(req.body.offer_match) ? req.body.offer_match : String(req.body.offer_match).split(','))
        .map(s => s.trim())
        .filter(s => VALID_OFFER_MATCH.includes(s));
      update.offer_match = list.length ? list : ['any'];
    }

    const reference = await HermesReference.findByIdAndUpdate(req.params.id, update, { new: true })
      .select('-image_base64')
      .lean();
    if (!reference) return res.status(404).json({ error: 'Reference not found' });
    res.json({ reference });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/hermes/references/:id — elimina la referencia
 */
router.delete('/references/:id', async (req, res) => {
  try {
    const ref = await HermesReference.findByIdAndDelete(req.params.id).lean();
    if (!ref) return res.status(404).json({ error: 'Reference not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Comment Intelligence — leer/clasificar/responder comentarios de ads
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/hermes/comments
 * Query: ?status=drafted (cola de aprobación) | ?proposal_id=X | ?classification=Y
 * Default: últimos comentarios clasificados.
 */
router.get('/comments', async (req, res) => {
  try {
    const HermesComment = require('../../db/models/HermesComment');
    const { proposal_id, classification, reply_status, days = 14, limit = 200 } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 86400000);
    const query = { created_time: { $gte: since } };
    if (proposal_id) query.proposal_id = proposal_id;
    if (classification && classification !== 'all') query.classification = classification;
    if (reply_status && reply_status !== 'all') query.reply_status = reply_status;

    const comments = await HermesComment.find(query)
      .sort({ created_time: -1 })
      .limit(parseInt(limit))
      .lean();
    res.json({ comments, count: comments.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/hermes/comments/intent-summary
 * Score de intención agregado por oferta — qué creativo/oferta mueve gente.
 */
router.get('/comments/intent-summary', async (req, res) => {
  try {
    const HermesComment = require('../../db/models/HermesComment');
    const { days = 30 } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 86400000);
    const rows = await HermesComment.aggregate([
      { $match: { created_time: { $gte: since }, classification: { $ne: 'unclassified' } } },
      { $group: {
        _id: '$offer_type',
        total: { $sum: 1 },
        avg_intent: { $avg: '$intent_score' },
        intent_visit: { $sum: { $cond: [{ $eq: ['$classification', 'intent_visit'] }, 1, 0] } },
        questions: { $sum: { $cond: [{ $eq: ['$classification', 'question_logistics'] }, 1, 0] } },
        visits_reported: { $sum: { $cond: [{ $eq: ['$classification', 'visit_reported'] }, 1, 0] } },
        creative_issues: { $sum: { $cond: ['$flags_creative_issue', 1, 0] } }
      }},
      { $sort: { avg_intent: -1 } }
    ]);
    res.json({ summary: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/hermes/comments/flagged-creatives
 * Creativos con problema de percepción del visual (≥2 comentarios negativos).
 */
router.get('/comments/flagged-creatives', async (req, res) => {
  try {
    const { detectCreativeIssues } = require('../../ai/hermes/comment-intelligence');
    const flagged = await detectCreativeIssues();
    res.json({ flagged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/hermes/comments/:id/reply — editar el texto de la respuesta draft
 */
router.patch('/comments/:id/reply', async (req, res) => {
  try {
    const HermesComment = require('../../db/models/HermesComment');
    const { reply_text } = req.body;
    if (!reply_text?.trim()) return res.status(400).json({ error: 'reply_text requerido' });
    const doc = await HermesComment.findByIdAndUpdate(
      req.params.id,
      { $set: { reply_text: reply_text.trim() } },
      { new: true }
    ).lean();
    if (!doc) return res.status(404).json({ error: 'comentario no encontrado' });
    res.json({ comment: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/hermes/comments/:id/approve-reply — publica la respuesta a Meta.
 * Escribe en la página pública.
 */
router.post('/comments/:id/approve-reply', async (req, res) => {
  try {
    const { postApprovedReply } = require('../../ai/hermes/comment-intelligence');
    const result = await postApprovedReply(req.params.id, req.user?.username || 'user');
    res.json(result);
  } catch (err) {
    logger.error(`[HERMES-API] approve-reply failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/hermes/comments/:id/skip-reply — descarta la respuesta (no publica)
 */
router.post('/comments/:id/skip-reply', async (req, res) => {
  try {
    const HermesComment = require('../../db/models/HermesComment');
    const doc = await HermesComment.findByIdAndUpdate(
      req.params.id,
      { $set: { reply_status: 'skipped', reply_decided_by: req.user?.username || 'user' } },
      { new: true }
    ).lean();
    if (!doc) return res.status(404).json({ error: 'comentario no encontrado' });
    res.json({ comment: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/hermes/comments/run-cycle — dispara el ciclo manualmente (on-demand)
 */
router.post('/comments/run-cycle', async (req, res) => {
  try {
    const { runCommentIntelligenceCycle } = require('../../ai/hermes/comment-intelligence');
    const result = await runCommentIntelligenceCycle();
    res.json(result);
  } catch (err) {
    logger.error(`[HERMES-API] run-cycle failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
