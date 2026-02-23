/**
 * Video Generation Routes — "Director Creativo" Mode
 *
 * Pipeline: Upload photo → Claude recommends scene + designs shots →
 *           OpenAI generates shots (async) → Claude judges quality →
 *           User reviews storyboard → Kling 2.6 creates videos
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../../../config');
const logger = require('../../utils/logger');
const {
  AVAILABLE_SCENES, SHOT_TYPES, NARRATIVE_BEATS, CAMERA_MOTIONS,
  analyzeProductAndRecommendScene,
  startShotGenerationJob, getShotJobStatus,
  judgeShots, regenerateSingleShot,
  submitVideoJob, checkVideoStatus, submitVideoBatch,
  startStitchJob, getStitchJobStatus
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

// ============ GET /api/video/scenes ============

router.get('/scenes', (req, res) => {
  res.json({ scenes: AVAILABLE_SCENES, count: AVAILABLE_SCENES.length });
});

// ============ GET /api/video/shot-types ============

router.get('/shot-types', (req, res) => {
  res.json({ shotTypes: SHOT_TYPES, count: SHOT_TYPES.length });
});

// ============ GET /api/video/narrative-beats ============

router.get('/narrative-beats', (req, res) => {
  res.json({ beats: NARRATIVE_BEATS, count: NARRATIVE_BEATS.length });
});

// ============ GET /api/video/motions ============

router.get('/motions', (req, res) => {
  res.json({ motions: CAMERA_MOTIONS, count: CAMERA_MOTIONS.length });
});

// ============ POST /api/video/upload-product ============

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

// ============ POST /api/video/analyze-scene ============
// Claude "Director Creativo": analyze product + recommend scene + design 12 shots

router.post('/analyze-scene', async (req, res) => {
  try {
    const { productImagePath, productDescription } = req.body;

    if (!productImagePath) {
      return res.status(400).json({ error: 'productImagePath is required' });
    }

    let fullPath = productImagePath;
    if (productImagePath.startsWith('/uploads/')) {
      fullPath = path.join(config.system.uploadsDir, productImagePath.replace('/uploads/', ''));
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(400).json({ error: 'Product image file not found' });
    }

    logger.info(`[VIDEO] Claude Director analyzing product: ${fullPath}`);
    const analysis = await analyzeProductAndRecommendScene(fullPath, productDescription || 'product');

    res.json(analysis);
  } catch (err) {
    logger.error('[VIDEO] Analyze scene error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ GET /api/video/shots ============

router.get('/shots', (req, res) => {
  try {
    const shotsDir = path.join(config.system.uploadsDir, 'video-shots');
    if (!fs.existsSync(shotsDir)) return res.json({ shots: [] });

    const files = fs.readdirSync(shotsDir)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map(f => {
        const stats = fs.statSync(path.join(shotsDir, f));
        const shotKey = f.match(/shot-([a-z-]+)-/)?.[1] || 'unknown';
        const shotType = SHOT_TYPES.find(s => s.key === shotKey);
        return {
          filename: f, angle: shotKey,
          label: shotType?.label || shotKey,
          url: `/uploads/video-shots/${f}`,
          size: stats.size, created: stats.mtime
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({ shots: files, count: files.length });
  } catch (err) {
    logger.error('[VIDEO] List shots error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ POST /api/video/generate-shots ============
// ASYNC: returns jobId immediately, generates in background

router.post('/generate-shots', (req, res) => {
  try {
    const { productImagePath, productDescription, numShots, directorPlan } = req.body;

    if (!productImagePath) {
      return res.status(400).json({ error: 'productImagePath is required' });
    }

    let fullPath = productImagePath;
    if (productImagePath.startsWith('/uploads/')) {
      fullPath = path.join(config.system.uploadsDir, productImagePath.replace('/uploads/', ''));
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(400).json({ error: 'Product image file not found' });
    }

    logger.info(`[VIDEO] Starting async shot generation from: ${fullPath}`);

    const result = startShotGenerationJob(fullPath, {
      productDescription: productDescription || 'packaged food product',
      numShots: numShots || 12,
      directorPlan: directorPlan || null
    });

    res.json(result);
  } catch (err) {
    logger.error('[VIDEO] Generate shots error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ GET /api/video/shots-job/:jobId ============

router.get('/shots-job/:jobId', (req, res) => {
  try {
    const status = getShotJobStatus(req.params.jobId);
    if (!status) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(status);
  } catch (err) {
    logger.error('[VIDEO] Job status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ POST /api/video/judge-shots ============
// Claude Quality Judge: score each generated shot

router.post('/judge-shots', async (req, res) => {
  try {
    const { shots, productDescription, originalImagePath } = req.body;

    if (!shots || !Array.isArray(shots) || shots.length === 0) {
      return res.status(400).json({ error: 'shots array is required' });
    }

    let fullOrigPath = originalImagePath;
    if (originalImagePath?.startsWith('/uploads/')) {
      fullOrigPath = path.join(config.system.uploadsDir, originalImagePath.replace('/uploads/', ''));
    }

    logger.info(`[VIDEO] Claude Quality Judge evaluating ${shots.length} shots`);
    const scores = await judgeShots(shots, productDescription || '', fullOrigPath);

    res.json(scores);
  } catch (err) {
    logger.error('[VIDEO] Judge shots error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ POST /api/video/regenerate-shot ============
// Regenerate a single shot that scored low

router.post('/regenerate-shot', async (req, res) => {
  try {
    const { productImagePath, shotKey, imagePrompt, productDescription } = req.body;

    if (!productImagePath || !shotKey || !imagePrompt) {
      return res.status(400).json({ error: 'productImagePath, shotKey, and imagePrompt are required' });
    }

    let fullPath = productImagePath;
    if (productImagePath.startsWith('/uploads/')) {
      fullPath = path.join(config.system.uploadsDir, productImagePath.replace('/uploads/', ''));
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(400).json({ error: 'Product image file not found' });
    }

    logger.info(`[VIDEO] Regenerating shot: ${shotKey}`);
    const result = await regenerateSingleShot(fullPath, shotKey, imagePrompt, productDescription || 'product');

    res.json(result);
  } catch (err) {
    logger.error('[VIDEO] Regenerate shot error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ POST /api/video/generate-clip ============

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

// ============ POST /api/video/stitch ============
// Concatenate completed video clips into ONE commercial video

router.post('/stitch', (req, res) => {
  try {
    const { clipUrls } = req.body;

    if (!clipUrls || !Array.isArray(clipUrls) || clipUrls.length < 2) {
      return res.status(400).json({ error: 'clipUrls array with at least 2 URLs is required' });
    }
    if (clipUrls.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 clips per stitch' });
    }

    logger.info(`[VIDEO] Starting stitch job: ${clipUrls.length} clips`);
    const result = startStitchJob(clipUrls);
    res.json(result);
  } catch (err) {
    logger.error('[VIDEO] Stitch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ GET /api/video/stitch-status/:jobId ============

router.get('/stitch-status/:jobId', (req, res) => {
  try {
    const status = getStitchJobStatus(req.params.jobId);
    if (!status) {
      return res.status(404).json({ error: 'Stitch job not found' });
    }
    res.json(status);
  } catch (err) {
    logger.error('[VIDEO] Stitch status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ DELETE /api/video/shots/:filename ============

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
