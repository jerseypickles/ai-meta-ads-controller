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
  '/ai-creations/'
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
app.use('/api/demeter', require('./routes/demeter'));

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
