/**
 * Video Generation Routes
 *
 * Pipeline: Upload product photo → OpenAI generates angle shots → Kling 2.6 creates videos
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../../../config');
const logger = require('../../utils/logger');
const {
  PRODUCT_ANGLES, CAMERA_MOTIONS,
  generateAngleShots, submitVideoJob, checkVideoStatus, submitVideoBatch
} = require('../../video/video-pipeline');

// ============ UPLOAD CONFIG ============

const UPLOAD_DIR = path.join(config.system.uploadsDir, 'video-photos');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E6)}`;
    const ext = path.extname(file.originalname);
    cb(null, `product${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
  limits: { fileSize: 20 * 1024 * 1024 }
});

// ============ GET /api/video/angles ============
// List available product angles

router.get('/angles', (req, res) => {
  res.json({ angles: PRODUCT_ANGLES, count: PRODUCT_ANGLES.length });
});

// ============ GET /api/video/motions ============
// List available camera motions for video

router.get('/motions', (req, res) => {
  res.json({ motions: CAMERA_MOTIONS, count: CAMERA_MOTIONS.length });
});

// ============ POST /api/video/upload-product ============
// Upload the source product photo

router.post('/upload-product', upload.single('photo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

    res.json({
      filename: req.file.filename,
      originalName: req.file.originalname,
      url: `/uploads/video-photos/${req.file.filename}`,
      path: req.file.path,
      size: req.file.size
    });
  } catch (err) {
    logger.error('[VIDEO] Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ GET /api/video/shots ============
// List generated angle shots

router.get('/shots', (req, res) => {
  try {
    const shotsDir = path.join(config.system.uploadsDir, 'video-shots');
    if (!fs.existsSync(shotsDir)) return res.json({ shots: [] });

    const files = fs.readdirSync(shotsDir)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map(f => {
        const stats = fs.statSync(path.join(shotsDir, f));
        const angle = f.match(/shot-([a-z-]+)-/)?.[1] || 'unknown';
        return { filename: f, angle, url: `/uploads/video-shots/${f}`, size: stats.size, created: stats.mtime };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({ shots: files, count: files.length });
  } catch (err) {
    logger.error('[VIDEO] List shots error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ POST /api/video/generate-shots ============
// Step 1: Generate 12 angle shots from the product photo using OpenAI

router.post('/generate-shots', async (req, res) => {
  try {
    const { productImagePath, productDescription, numShots } = req.body;

    if (!productImagePath) {
      return res.status(400).json({ error: 'productImagePath is required' });
    }

    // Resolve path — could be absolute or relative /uploads/ path
    let fullPath = productImagePath;
    if (productImagePath.startsWith('/uploads/')) {
      fullPath = path.join(config.system.uploadsDir, productImagePath.replace('/uploads/', ''));
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(400).json({ error: 'Product image file not found' });
    }

    logger.info(`[VIDEO] Generating ${numShots || 12} angle shots from: ${fullPath}`);

    const shots = await generateAngleShots(fullPath, {
      productDescription: productDescription || 'packaged food product',
      numShots: numShots || 12
    });

    const completed = shots.filter(s => s.status === 'completed').length;
    const failed = shots.filter(s => s.status === 'failed').length;

    logger.info(`[VIDEO] Shots generated: ${completed} ok, ${failed} failed`);
    res.json({ shots, completed, failed });
  } catch (err) {
    logger.error('[VIDEO] Generate shots error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ POST /api/video/generate-clip ============
// Step 2a: Generate ONE video clip from a shot image

router.post('/generate-clip', async (req, res) => {
  try {
    const { imageUrl, cameraMotion, duration, prompt } = req.body;

    if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' });

    const result = await submitVideoJob(imageUrl, { cameraMotion, duration, prompt });

    logger.info(`[VIDEO] Clip job queued: ${result.requestId}`);
    res.json(result);
  } catch (err) {
    logger.error('[VIDEO] Generate clip error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ POST /api/video/generate-clips-batch ============
// Step 2b: Generate video clips from multiple shots

router.post('/generate-clips-batch', async (req, res) => {
  try {
    const { shots, cameraMotion, duration, prompt } = req.body;

    if (!shots || !Array.isArray(shots) || shots.length === 0) {
      return res.status(400).json({ error: 'shots array is required' });
    }
    if (shots.length > 15) {
      return res.status(400).json({ error: 'Maximum 15 shots per batch' });
    }

    const results = await submitVideoBatch(shots, { cameraMotion, duration, prompt });

    const queued = results.filter(r => r.status === 'queued').length;
    const errors = results.filter(r => r.status === 'error').length;

    logger.info(`[VIDEO] Batch clips: ${queued} queued, ${errors} errors`);
    res.json({ jobs: results, queued, errors });
  } catch (err) {
    logger.error('[VIDEO] Batch clips error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ GET /api/video/clip-status/:requestId ============
// Check status of a video clip job

router.get('/clip-status/:requestId', async (req, res) => {
  try {
    const result = await checkVideoStatus(req.params.requestId);
    res.json(result);
  } catch (err) {
    logger.error('[VIDEO] Status check error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ POST /api/video/clip-status-batch ============
// Check status of multiple clip jobs

router.post('/clip-status-batch', async (req, res) => {
  try {
    const { requestIds } = req.body;
    if (!requestIds || !Array.isArray(requestIds)) {
      return res.status(400).json({ error: 'requestIds array required' });
    }

    const results = [];
    for (const id of requestIds) {
      try {
        const status = await checkVideoStatus(id);
        results.push(status);
      } catch (err) {
        results.push({ requestId: id, status: 'error', error: err.message });
      }
    }

    res.json({ jobs: results });
  } catch (err) {
    logger.error('[VIDEO] Batch status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ DELETE /api/video/shots/:filename ============
// Delete a shot

router.delete('/shots/:filename', (req, res) => {
  try {
    const shotsDir = path.join(config.system.uploadsDir, 'video-shots');
    const filePath = path.join(shotsDir, req.params.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
