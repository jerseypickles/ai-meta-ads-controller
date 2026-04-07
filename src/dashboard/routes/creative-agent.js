const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const logger = require('../../utils/logger');
const ProductBank = require('../../db/models/ProductBank');
const config = require('../../../config');

// Upload config for product PNGs — almacenar en memoria, guardar como base64 en DB
const productUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo imagenes permitidas'));
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ═══ Product Bank CRUD ═══

/**
 * GET /api/creative-agent/products — List all products
 */
router.get('/products', async (req, res) => {
  try {
    const products = await ProductBank.find({}).sort({ created_at: -1 }).lean();
    res.json({ products });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/creative-agent/products — Create new product
 */
router.post('/products', productUpload.array('images', 5), async (req, res) => {
  try {
    const { product_name, product_slug, link_url } = req.body;
    if (!product_name || !product_slug) {
      return res.status(400).json({ error: 'product_name and product_slug required' });
    }

    const png_references = (req.files || []).map((file, i) => ({
      filename: `product_${Date.now()}_${Math.random().toString(36).substring(2, 6)}${path.extname(file.originalname)}`,
      original_name: file.originalname,
      type: req.body[`type_${i}`] || 'front-view',
      image_base64: file.buffer.toString('base64'),
      mime_type: file.mimetype
    }));

    const product = await ProductBank.create({
      product_name,
      product_slug,
      link_url: link_url || 'https://jerseypickles.com',
      png_references
    });

    logger.info(`[CREATIVE-AGENT] Product created: ${product_name} with ${png_references.length} PNGs`);
    res.json({ success: true, product });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/creative-agent/products/:id/images — Add PNGs to existing product
 */
router.post('/products/:id/images', productUpload.array('images', 5), async (req, res) => {
  try {
    const product = await ProductBank.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const newRefs = (req.files || []).map((file, i) => ({
      filename: `product_${Date.now()}_${Math.random().toString(36).substring(2, 6)}${path.extname(file.originalname)}`,
      original_name: file.originalname,
      type: req.body[`type_${i}`] || 'front-view',
      image_base64: file.buffer.toString('base64'),
      mime_type: file.mimetype
    }));

    product.png_references.push(...newRefs);
    product.updated_at = new Date();
    await product.save();

    logger.info(`[CREATIVE-AGENT] Added ${newRefs.length} PNGs to ${product.product_name}`);
    res.json({ success: true, product });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/creative-agent/products/:id — Delete product
 */
router.delete('/products/:id', async (req, res) => {
  try {
    const product = await ProductBank.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/creative-agent/products/:id/image/:filename — Serve product PNG from DB
 */
router.get('/products/:id/image/:filename', async (req, res) => {
  try {
    const product = await ProductBank.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const ref = product.png_references.find(r => r.filename === req.params.filename);
    if (!ref) return res.status(404).json({ error: 'Image not found' });

    // Servir desde base64 en DB
    if (ref.image_base64) {
      const buffer = Buffer.from(ref.image_base64, 'base64');
      res.set('Content-Type', ref.mime_type || 'image/jpeg');
      res.set('Content-Length', buffer.length);
      return res.send(buffer);
    }

    // Fallback: intentar desde disco (productos viejos)
    const productUploadDir = path.join(config.system.uploadsDir || 'uploads', 'product-bank');
    const filePath = path.join(productUploadDir, req.params.filename);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);

    res.status(404).json({ error: 'Image not found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══ Creative Agent Control ═══

const _creativeJobs = {};

/**
 * POST /api/creative-agent/run — Trigger Creative Agent manually
 */
router.post('/run', async (req, res) => {
  try {
    const jobId = `creative_job_${Date.now()}`;
    _creativeJobs[jobId] = { status: 'running', started_at: new Date() };
    res.json({ async: true, job_id: jobId, message: 'Creative Agent iniciado' });

    const { runCreativeAgent } = require('../../ai/agent/creative-agent');
    runCreativeAgent().then(result => {
      _creativeJobs[jobId] = { status: 'completed', ...result };
    }).catch(err => {
      logger.error(`[CREATIVE-AGENT-API] Error: ${err.message}`);
      _creativeJobs[jobId] = { status: 'failed', error: err.message };
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/creative-agent/run-status/:jobId — Poll for completion
 */
router.get('/run-status/:jobId', (req, res) => {
  const job = _creativeJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
  if (job.status !== 'running') {
    setTimeout(() => delete _creativeJobs[req.params.jobId], 5 * 60 * 1000);
  }
});

/**
 * GET /api/creative-agent/scenes — List available scenes
 */
router.get('/scenes', (req, res) => {
  const { SCENES } = require('../../ai/agent/creative-agent');
  res.json({ scenes: SCENES });
});

// ═══ Creative Proposals ═══

const CreativeProposal = require('../../db/models/CreativeProposal');

/**
 * GET /api/creative-agent/proposals — List proposals (pending first)
 */
router.get('/proposals', async (req, res) => {
  try {
    const status = req.query.status || '';
    const query = status ? { status } : { status: { $ne: 'rejected' } };
    const proposals = await CreativeProposal.find(query)
      .select('-image_base64 -prompt_used')
      .sort({ status: 1, created_at: -1 })
      .limit(100)
      .lean();

    const pending = proposals.filter(p => p.status === 'pending' || p.status === 'ready').length;
    res.json({ proposals, pending_count: pending });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/creative-agent/proposals/:id/approve — Approve and upload to Meta
 */
router.post('/proposals/:id/approve', async (req, res) => {
  try {
    const { approveProposal } = require('../../ai/agent/creative-agent');
    const result = await approveProposal(req.params.id);
    res.json(result);
  } catch (error) {
    logger.error(`[CREATIVE-AGENT] Approve error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/creative-agent/proposals/:id/reject — Reject proposal
 */
router.post('/proposals/:id/reject', async (req, res) => {
  try {
    const { rejectProposal } = require('../../ai/agent/creative-agent');
    const result = await rejectProposal(req.params.id, req.body.reason || '');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/creative-agent/proposals/:id/image — Serve generated image
 */
router.get('/proposals/:id/image', async (req, res) => {
  try {
    const proposal = await CreativeProposal.findById(req.params.id).lean();
    if (!proposal) return res.status(404).json({ error: 'Not found' });

    // Try file first, fall back to base64 from DB
    if (proposal.image_path && fs.existsSync(proposal.image_path)) {
      res.sendFile(proposal.image_path);
    } else if (proposal.image_base64) {
      const buffer = Buffer.from(proposal.image_base64, 'base64');
      res.set('Content-Type', 'image/png');
      res.send(buffer);
    } else {
      res.status(404).json({ error: 'Image not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
