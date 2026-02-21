const express = require('express');
const router = express.Router();
const { getActionsPaginated, getActionsForEntity } = require('../../db/queries');

// GET /api/actions — Log de acciones ejecutadas (paginado)
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const result = await getActionsPaginated(page, limit);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/actions/:entityId — Acciones para una entidad específica
router.get('/:entityId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const actions = await getActionsForEntity(req.params.entityId, limit);
    res.json(actions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
