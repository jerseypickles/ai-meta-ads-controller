/**
 * TRIBE v2 validation experiment helpers.
 *
 * GET /api/system/tribe-validation/sample
 *   Returns 10 winners + 10 losers with preview URLs and copy text,
 *   ready to score with TRIBE v2 in a Colab notebook.
 */

const express = require('express');
const router = express.Router();
const CreativeAsset = require('../../db/models/CreativeAsset');

router.get('/sample', async (req, res) => {
  try {
    const n = parseInt(req.query.n) || 10;
    const minRoas = parseFloat(req.query.min_winner_roas) || 3.0;
    const maxRoas = parseFloat(req.query.max_loser_roas) || 1.5;
    const minUses = parseInt(req.query.min_uses) || 1;

    const baseUrl = req.protocol + '://' + req.get('host');

    const [winners, losers] = await Promise.all([
      CreativeAsset.find({
        status: 'active',
        avg_roas: { $gte: minRoas },
        times_used: { $gte: minUses },
        media_type: 'image'
      })
        .sort({ avg_roas: -1 })
        .limit(n)
        .lean(),
      CreativeAsset.find({
        status: 'active',
        avg_roas: { $gt: 0, $lte: maxRoas },
        times_used: { $gte: minUses },
        media_type: 'image'
      })
        .sort({ avg_roas: 1 })
        .limit(n)
        .lean()
    ]);

    const mapItem = (c, label) => ({
      id: c._id,
      label,
      preview_url: `${baseUrl}/api/creatives/${c._id}/preview`,
      filename: c.filename,
      headline: c.headline || '',
      body: c.body || '',
      description: c.description || '',
      product_name: c.product_name || '',
      avg_roas: c.avg_roas,
      avg_ctr: c.avg_ctr,
      times_used: c.times_used,
      style: c.style,
      generated_by: c.generated_by
    });

    res.json({
      winners: winners.map(c => mapItem(c, 'winner')),
      losers: losers.map(c => mapItem(c, 'loser')),
      criteria: {
        min_winner_roas: minRoas,
        max_loser_roas: maxRoas,
        min_uses: minUses,
        n_each: n
      },
      counts: {
        winners: winners.length,
        losers: losers.length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
