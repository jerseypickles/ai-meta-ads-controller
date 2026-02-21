const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../../../config');
const router = express.Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (username === config.dashboard.user && password === config.dashboard.password) {
    const token = jwt.sign(
      { user: username, role: 'admin' },
      config.dashboard.secret,
      { expiresIn: '24h' }
    );

    return res.json({
      success: true,
      token,
      user: { username, role: 'admin' }
    });
  }

  return res.status(401).json({ error: 'Credenciales inválidas' });
});

// GET /api/auth/verify
router.get('/verify', (req, res) => {
  res.json({ valid: true, user: req.user });
});

module.exports = router;
