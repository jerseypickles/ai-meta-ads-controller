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
const authRoutes = require('./routes/auth');
const metaAuthRoutes = require('./routes/meta-auth');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Servir frontend estático
app.use(express.static(path.join(__dirname, 'frontend', 'dist')));

// Servir uploads como archivos estáticos (antes de auth, para que <img src> funcione)
app.use('/uploads', express.static(config.system.uploadsDir));

// Auth middleware simple (JWT)
const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  // Rutas públicas (req.path es relativo a /api cuando se monta con app.use('/api'))
  if (req.path === '/auth/login') return next();
  if (req.path.startsWith('/auth/meta/callback')) return next();

  const token = req.headers.authorization?.replace('Bearer ', '');
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
