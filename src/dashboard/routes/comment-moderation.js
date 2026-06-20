/**
 * Comment Moderation routes — revisión + control del moderador de comentarios.
 *
 * GET  /config              — config actual (blocklist, shadow, enabled)
 * POST /config              — actualizar config (blocklist, ai_callouts, etc)
 * POST /toggle-shadow       — { shadow: bool } pasar shadow↔live
 * GET  /log?action=would_hide — comentarios moderados (revisión)
 * POST /run                 — gatillar un ciclo ahora (async)
 * POST /unhide/:commentId   — revertir (volver a mostrar) un comentario
 * POST /hide/:commentId     — ocultar a mano uno que estaba en would_hide
 */
const express = require('express');
const router = express.Router();
const logger = require('../../utils/logger');
const SystemConfig = require('../../db/models/SystemConfig');
const CommentModerationLog = require('../../db/models/CommentModerationLog');
const { getConfig, CONFIG_KEY, DEFAULT_CONFIG } = require('../../ai/agent/comment-moderator');

router.get('/config', async (req, res) => {
  try { res.json(await getConfig()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/config', async (req, res) => {
  try {
    const cur = await getConfig();
    // solo campos conocidos; arrays se reemplazan completos
    const next = { ...cur };
    for (const k of ['enabled', 'shadow', 'ai_callouts']) if (typeof req.body[k] === 'boolean') next[k] = req.body[k];
    for (const k of ['ai_words', 'ai_phrases', 'custom_words', 'custom_phrases']) {
      if (Array.isArray(req.body[k])) next[k] = req.body[k].map(s => String(s).trim()).filter(Boolean);
    }
    await SystemConfig.set(CONFIG_KEY, next, req.user?.user || 'dashboard');
    res.json(next);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/toggle-shadow', async (req, res) => {
  try {
    const cur = await getConfig();
    cur.shadow = !!req.body.shadow;
    await SystemConfig.set(CONFIG_KEY, cur, req.user?.user || 'dashboard');
    logger.info(`[COMMENT-MOD] modo → ${cur.shadow ? 'SHADOW' : 'LIVE'} (desde el panel)`);
    res.json({ shadow: cur.shadow });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/log', async (req, res) => {
  try {
    const { action, limit = 200 } = req.query;
    const q = {};
    if (action && action !== 'all') q.action = action;
    const logs = await CommentModerationLog.find(q).sort({ created_at: -1 }).limit(parseInt(limit, 10)).lean();
    const counts = await CommentModerationLog.aggregate([{ $group: { _id: '$action', n: { $sum: 1 } } }]);
    res.json({ logs, counts: counts.reduce((a, c) => { a[c._id] = c.n; return a; }, {}) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/run', async (req, res) => {
  try {
    const { runCommentModeration } = require('../../ai/agent/comment-moderator');
    runCommentModeration()
      .then(r => logger.info(`[COMMENT-MOD] run manual: ${JSON.stringify(r)}`))
      .catch(e => logger.error(`[COMMENT-MOD] run manual falló: ${e.message}`));
    res.json({ started: true, message: 'Moderación corriendo (revisá el log en unos segundos)' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Revertir: volver a mostrar un comentario ocultado
router.post('/unhide/:commentId', async (req, res) => {
  try {
    const { getMetaClient } = require('../../meta/client');
    await getMetaClient().hideComment(req.params.commentId, false);
    await CommentModerationLog.findOneAndUpdate({ comment_id: req.params.commentId }, { $set: { action: 'unhidden' } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ocultar a mano uno que el shadow marcó como would_hide (o un falso negativo)
router.post('/hide/:commentId', async (req, res) => {
  try {
    const { getMetaClient } = require('../../meta/client');
    await getMetaClient().hideComment(req.params.commentId, true);
    await CommentModerationLog.findOneAndUpdate({ comment_id: req.params.commentId }, { $set: { action: 'hidden', shadow: false } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /preview-campaign?name=... | ?campaign_id=... — lee TODOS los comentarios de los ads
// de una campaña y marca cuáles ocultaría (verificación read-only, no toca nada).
router.get('/preview-campaign', async (req, res) => {
  try {
    const MetricSnapshot = require('../../db/models/MetricSnapshot');
    const { matchComment } = require('../../ai/agent/comment-moderator');
    const { getMetaClient } = require('../../meta/client');
    const cfg = await getConfig();

    let campaignId = req.query.campaign_id;
    if (!campaignId && req.query.name) {
      // resolver nombre → campaign_id desde el snapshot de campaña más reciente
      const camp = await MetricSnapshot.findOne({
        entity_type: 'campaign',
        entity_name: { $regex: req.query.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
      }).sort({ snapshot_at: -1 }).select('entity_id entity_name').lean();
      if (!camp) return res.status(404).json({ error: `No encontré campaña que matchee "${req.query.name}"` });
      campaignId = camp.entity_id;
    }
    if (!campaignId) return res.status(400).json({ error: 'pasá ?name= o ?campaign_id=' });

    // ads de esa campaña (último snapshot por ad)
    const ads = await MetricSnapshot.aggregate([
      { $match: { entity_type: 'ad', campaign_id: campaignId } },
      { $sort: { entity_id: 1, snapshot_at: -1 } },
      { $group: { _id: '$entity_id', status: { $first: '$status' }, name: { $first: '$entity_name' } } }
    ]);

    const meta = getMetaClient();
    const out = [];
    let totalComments = 0, totalWouldHide = 0;
    for (const ad of ads) {
      let r;
      try { r = await meta.getAdComments(ad._id, { limit: 100 }); }
      catch (e) { out.push({ ad_id: ad._id, ad_name: ad.name, error: e.message }); continue; }
      const comments = (r.comments || []).map(c => {
        const hit = matchComment(c.message, cfg);
        if (hit) totalWouldHide++;
        return { id: c.id, author: c.author_name, message: c.message, created: c.created_time, verdict: hit ? `OCULTAR (${hit.rule}:${hit.term})` : 'mantener' };
      });
      totalComments += comments.length;
      if (comments.length) out.push({ ad_id: ad._id, ad_name: ad.name, status: ad.status, comments });
    }
    res.json({ campaign_id: campaignId, ads_with_comments: out.length, total_comments: totalComments, would_hide: totalWouldHide, shadow: cfg.shadow, ads: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
