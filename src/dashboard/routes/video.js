/**
 * Video Generation Routes
 *
 * Endpoints for Higgsfield image-to-video generation.
 * Upload product photos, generate videos, check status.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../../../config');
const logger = require('../../utils/logger');
const { getHiggsfieldClient, PRODUCT_MOTION_PRESETS } = require('../../video/higgsfield-client');

// ============ UPLOAD CONFIG ============

const UPLOAD_DIR = path.join(config.system.uploadsDir, 'video-photos');

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
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}. Solo JPEG, PNG, WEBP.`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB per image
});

// ============ GET /api/video/presets ============
// List available motion presets for product videos

router.get('/presets', (req, res) => {
  try {
    const presets = PRODUCT_MOTION_PRESETS;
    const list = Object.entries(presets).map(([key, val]) => ({
      key,
      ...val
    }));
    res.json({ presets: list });
  } catch (err) {
    logger.error('[VIDEO] Error listing presets:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ GET /api/video/presets/all ============
// List ALL motion presets from Higgsfield API

router.get('/presets/all', async (req, res) => {
  try {
    const client = getHiggsfieldClient();
    const motions = await client.listMotions();
    res.json({ motions, count: Array.isArray(motions) ? motions.length : 0 });
  } catch (err) {
    logger.error('[VIDEO] Error listing all motions:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ POST /api/video/upload-photos ============
// Upload product photos (up to 15)

router.post('/upload-photos', upload.array('photos', 15), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No photos uploaded' });
    }

    const photos = req.files.map(f => ({
      filename: f.filename,
      originalName: f.originalname,
      size: f.size,
      mimetype: f.mimetype,
      url: `/uploads/video-photos/${f.filename}`
    }));

    logger.info(`[VIDEO] Uploaded ${photos.length} product photos`);
    res.json({ photos, count: photos.length });
  } catch (err) {
    logger.error('[VIDEO] Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ GET /api/video/photos ============
// List uploaded product photos

router.get('/photos', (req, res) => {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) {
      return res.json({ photos: [] });
    }

    const files = fs.readdirSync(UPLOAD_DIR)
      .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .map(f => {
        const stats = fs.statSync(path.join(UPLOAD_DIR, f));
        return {
          filename: f,
          url: `/uploads/video-photos/${f}`,
          size: stats.size,
          uploaded_at: stats.mtime
        };
      })
      .sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));

    res.json({ photos: files, count: files.length });
  } catch (err) {
    logger.error('[VIDEO] Error listing photos:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ DELETE /api/video/photos/:filename ============
// Delete a photo

router.delete('/photos/:filename', (req, res) => {
  try {
    const filePath = path.join(UPLOAD_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  } catch (err) {
    logger.error('[VIDEO] Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ POST /api/video/generate ============
// Generate video from a single image

router.post('/generate', async (req, res) => {
  try {
    const { imageUrl, prompt, model, motionPresetId } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ error: 'imageUrl is required' });
    }

    const client = getHiggsfieldClient();
    const result = await client.submitVideo(imageUrl, { prompt, model, motionPresetId });

    logger.info(`[VIDEO] Job submitted: ${result.jobSetId}`);
    res.json(result);
  } catch (err) {
    logger.error('[VIDEO] Generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ POST /api/video/generate-batch ============
// Generate videos from multiple images in batch

router.post('/generate-batch', async (req, res) => {
  try {
    const { images, prompt, model, motionPresetId } = req.body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'images array is required' });
    }

    if (images.length > 15) {
      return res.status(400).json({ error: 'Maximum 15 images per batch' });
    }

    const client = getHiggsfieldClient();

    // Build image list with per-image or global options
    const imageList = images.map(img => ({
      imageUrl: typeof img === 'string' ? img : img.imageUrl,
      prompt: (typeof img === 'object' ? img.prompt : null) || prompt,
      motionPresetId: (typeof img === 'object' ? img.motionPresetId : null) || motionPresetId,
      model: (typeof img === 'object' ? img.model : null) || model
    }));

    const results = await client.submitBatch(imageList, { prompt, model, motionPresetId });

    const submitted = results.filter(r => r.status === 'submitted').length;
    const errors = results.filter(r => r.status === 'error').length;

    logger.info(`[VIDEO] Batch submitted: ${submitted} jobs, ${errors} errors`);
    res.json({ jobs: results, submitted, errors });
  } catch (err) {
    logger.error('[VIDEO] Batch generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ GET /api/video/status/:jobSetId ============
// Check status of a video generation job

router.get('/status/:jobSetId', async (req, res) => {
  try {
    const client = getHiggsfieldClient();
    const result = await client.checkStatus(req.params.jobSetId);
    res.json(result);
  } catch (err) {
    logger.error('[VIDEO] Status check error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ POST /api/video/status-batch ============
// Check status of multiple jobs at once

router.post('/status-batch', async (req, res) => {
  try {
    const { jobSetIds } = req.body;
    if (!jobSetIds || !Array.isArray(jobSetIds)) {
      return res.status(400).json({ error: 'jobSetIds array required' });
    }

    const client = getHiggsfieldClient();
    const results = [];

    for (const id of jobSetIds) {
      try {
        const status = await client.checkStatus(id);
        results.push(status);
      } catch (err) {
        results.push({ jobSetId: id, status: 'error', error: err.message, results: [] });
      }
    }

    res.json({ jobs: results });
  } catch (err) {
    logger.error('[VIDEO] Batch status error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
