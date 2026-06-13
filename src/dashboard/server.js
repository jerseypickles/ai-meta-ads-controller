const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('../../config');
const logger = require('../utils/logger');
const db = require('../db/connection');

// Routes
const metricsRoutes = require('./routes/metrics');
const decisionsRoutes = require('./routes/decisions');
const actionsRoutes = require('./routes/actions');
const controlsRoutes = require('./routes/controls');
const settingsRoutes = require('./routes/settings');
const agentsRoutes = require('./routes/agents');
const strategicRoutes = require('./routes/strategic');
const creativesRoutes = require('./routes/creatives');
const aiCreationsRoutes = require('./routes/ai-creations');
const adsetCreatorRoutes = require('./routes/adset-creator');
const aiOpsRoutes = require('./routes/ai-ops');
const videoRoutes = require('./routes/video');
const brainRoutes = require('./routes/brain');
const briefingRoutes = require('./routes/briefing');
const agentRoutes = require('./routes/agent');
const creativeAgentRoutes = require('./routes/creative-agent');
const testingAgentRoutes = require('./routes/testing-agent');
const zeusRoutes = require('./routes/zeus');
const zeusChatRoutes = require('./routes/zeus-chat');
const aresRoutes = require('./routes/ares');
const overviewRoutes = require('./routes/overview');
const authRoutes = require('./routes/auth');
const metaAuthRoutes = require('./routes/meta-auth');

const app = express();

// Middleware
// CORS restringido — fix security 2026-04-24: antes cors() sin options
// permitía cualquier origen hacer requests con credentials. El frontend se
// sirve desde el mismo host via express.static, así que en producción no
// debería haber cross-origin real. Env var CORS_ALLOWED_ORIGINS (CSV) para
// casos especiales (ej. staging separado, preview deploys).
const corsAllowed = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: function (origin, callback) {
    // Same-origin o tools sin origen (curl, healthchecks): permitir
    if (!origin) return callback(null, true);
    if (corsAllowed.length === 0) {
      // Sin whitelist → solo same-origin (rechazar cross-origin)
      return callback(null, false);
    }
    if (corsAllowed.includes(origin)) return callback(null, true);
    logger.warn(`[CORS] origin rechazado: ${origin}`);
    return callback(null, false);
  },
  credentials: true
}));

app.use(express.json());

// Servir frontend estático
app.use(express.static(path.join(__dirname, 'frontend', 'dist')));

// Servir uploads como archivos estáticos (antes de auth, para que <img src> funcione)
app.use('/uploads', express.static(config.system.uploadsDir));

// Auth middleware simple (JWT)
const jwt = require('jsonwebtoken');

// Paths SSE donde query token es NECESARIO — EventSource no puede setear
// headers. Fix security 2026-04-24: antes aceptábamos ?token= en todo /api
// → JWT leaked en logs de Nginx/CF/Express. Ahora SOLO se acepta para SSE.
// Para resto, requerir Authorization header (no queda en access logs).
const SSE_PATHS = [
  '/metrics/stream',
  '/zeus/chat/stream',
  '/zeus/greeting/stream',
  '/brain/stream'  // defensivo por si hay más en el futuro
];

// Rutas que sirven assets via <img src> / <video src> / etc — el browser NO
// puede setear Authorization header en esos tags, así que necesitan query
// token. Mismo tradeoff que SSE (token en logs de access).
const QUERY_TOKEN_ASSET_PATHS = [
  '/testing-agent/tests/',  // /testing-agent/tests/:id/image
  '/creative-agent/',       // /creative-agent/proposals/:id/image + products
  '/creatives/',            // futuros endpoints de preview
  '/ai-creations/',
  '/hermes/'                // /hermes/photos/:id/image + /hermes/proposals/:id/image
];

function isSSEPath(pathname) {
  return SSE_PATHS.some(p => pathname === p || pathname.startsWith(p));
}

function isAssetPath(pathname) {
  return QUERY_TOKEN_ASSET_PATHS.some(p => pathname.startsWith(p)) && /\/(image|preview|thumbnail|video)\b/.test(pathname);
}

function authMiddleware(req, res, next) {
  // Rutas públicas (req.path es relativo a /api cuando se monta con app.use('/api'))
  if (req.path === '/auth/login') return next();
  if (req.path.startsWith('/auth/meta/callback')) return next();

  // Token: siempre preferir header. Solo caer a query para paths SSE
  // (EventSource no puede setear headers) y para assets que se consumen
  // desde <img src> / <video src> (tags HTML no permiten Auth header).
  let token = req.headers.authorization?.replace('Bearer ', '');
  if (!token && (isSSEPath(req.path) || isAssetPath(req.path))) {
    token = req.query.token;
  }
  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, config.dashboard.secret);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// Aplicar auth a rutas API
app.use('/api', authMiddleware);

// Rutas API
app.use('/api/auth', authRoutes);
app.use('/api/auth/meta', metaAuthRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/decisions', decisionsRoutes);
app.use('/api/actions', actionsRoutes);
app.use('/api/controls', controlsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/agents', agentsRoutes);
app.use('/api/strategic', strategicRoutes);
app.use('/api/creatives', creativesRoutes);
app.use('/api/ai-creations', aiCreationsRoutes);
app.use('/api/adset-creator', adsetCreatorRoutes);
app.use('/api/ai-ops', aiOpsRoutes);
app.use('/api/video', videoRoutes);
app.use('/api/brain', brainRoutes);
app.use('/api/brain', briefingRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/creative-agent', creativeAgentRoutes);
app.use('/api/testing-agent', testingAgentRoutes);
app.use('/api/zeus', zeusRoutes);
app.use('/api/zeus', zeusChatRoutes);
app.use('/api/ares', aresRoutes);
app.use('/api/overview', overviewRoutes);
app.use('/api/demeter', require('./routes/demeter'));
app.use('/api/hermes', require('./routes/hermes'));
app.use('/api/system/warehouse-throttle', require('./routes/warehouse-throttle'));
app.use('/api/dionysus', require('./routes/dionysus'));
app.use('/api/system/tribe-validation', require('./routes/tribe-validation'));

// Ruta PÚBLICA (sin auth) para servir la imagen origen de un proposal como PNG.
// La usa Dionisio: PiAPI/Seedance descarga la imagen vía esta URL pública para
// hacer image-to-video (image_urls requiere URL accesible, no base64). Solo
// expone creativos (no data sensible); el _id es difícil de adivinar.
app.get('/vsrc/:id.png', async (req, res) => {
  try {
    const CreativeProposal = require('../db/models/CreativeProposal');
    const p = await CreativeProposal.findById(req.params.id).select('image_base64').lean();
    if (!p || !p.image_base64) return res.status(404).send('not found');
    const b64 = p.image_base64;
    const mime = b64.startsWith('/9j/') ? 'image/jpeg'
      : b64.startsWith('iVBOR') ? 'image/png'
      : b64.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(Buffer.from(b64, 'base64'));
  } catch (e) {
    return res.status(400).send('bad request');
  }
});

// Video PERSISTIDO en Mongo (2026-06-13). Las URLs de PiAPI son /ephemeral/ y expiran
// → videos negros en la cola. Servimos el mp4 desde Mongo (base64), no expira. Público:
// Meta lo descarga al lanzar, y el panel lo reproduce desde acá. id = ObjectId (anti-traversal).
app.get('/vid/:id.mp4', async (req, res) => {
  try {
    if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(400).send('bad id');
    const CreativeProposal = require('../db/models/CreativeProposal');
    const p = await CreativeProposal.findById(req.params.id).select('video_base64').lean();
    if (!p || !p.video_base64) return res.status(404).send('not found');
    const buf = Buffer.from(p.video_base64, 'base64');
    res.set('Content-Type', 'video/mp4');
    res.set('Content-Length', String(buf.length));
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Accept-Ranges', 'bytes');
    return res.send(buf);
  } catch (e) {
    return res.status(400).send('bad request');
  }
});

// Video FINAL post-producido (hook overlay quemado). Público: Meta lo descarga al
// lanzar el test y el result-judge (Gemini) lo mira desde acá. (2026-06-10)
app.get('/vfinal/:id.mp4', (req, res) => {
  try {
    const { finalPathFor } = require('../ai/creative/video/video-postpro');
    const p = finalPathFor(req.params.id);
    if (!p || !require('fs').existsSync(p)) return res.status(404).send('not found');
    res.set('Content-Type', 'video/mp4');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.sendFile(p);
  } catch (e) {
    return res.status(400).send('bad request');
  }
});

// Frame FINAL del par first+last (piloto 2026-06-09). Mismo patrón público que /vsrc.
app.get('/vsrc/:id/end.png', async (req, res) => {
  try {
    const CreativeProposal = require('../db/models/CreativeProposal');
    const p = await CreativeProposal.findById(req.params.id).select('end_frame_base64').lean();
    if (!p || !p.end_frame_base64) return res.status(404).send('not found');
    const b64 = p.end_frame_base64;
    const mime = b64.startsWith('/9j/') ? 'image/jpeg'
      : b64.startsWith('iVBOR') ? 'image/png'
      : b64.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(Buffer.from(b64, 'base64'));
  } catch (e) {
    return res.status(400).send('bad request');
  }
});

// SPA fallback — todas las rutas no-API sirven el frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'dist', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Error en dashboard API:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

async function startDashboard() {
  await db.connect();

  const port = process.env.PORT || config.dashboard.port;
  app.listen(port, () => {
    logger.info(`Dashboard corriendo en http://localhost:${port}`);
  });
}

module.exports = { app, startDashboard };
