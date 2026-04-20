/**
 * Zeus Watchers — evalúa condiciones que el creador pidió monitorear y
 * dispara ping cuando se cumplen.
 */

const ZeusWatcher = require('../../db/models/ZeusWatcher');
const MetricSnapshot = require('../../db/models/MetricSnapshot');
const TestRun = require('../../db/models/TestRun');
const { getLatestSnapshots } = require('../../db/queries');
const logger = require('../../utils/logger');

async function evaluateCondition(watcher) {
  const type = watcher.condition_type;
  const p = watcher.condition_params || {};

  if (type === 'delivery_resumed' || type === 'spend_above') {
    const snapshots = await getLatestSnapshots('adset');
    const active = snapshots.filter(s => s.status === 'ACTIVE');
    const total = active.reduce((s, a) => s + (a.metrics?.today?.spend || 0), 0);
    const threshold = p.min_spend_today ?? p.amount ?? 100;
    if (total >= threshold) return { triggered: true, data: { spend_today: Math.round(total), threshold } };
    return { triggered: false };
  }

  if (type === 'roas_above' || type === 'roas_below') {
    const snapshots = await getLatestSnapshots('adset');
    const active = snapshots.filter(s => s.status === 'ACTIVE');
    const window = p.window || 'last_7d';
    const spend = active.reduce((s, a) => s + (a.metrics?.[window]?.spend || 0), 0);
    const revenue = active.reduce((s, a) => s + ((a.metrics?.[window]?.roas || 0) * (a.metrics?.[window]?.spend || 0)), 0);
    const roas = spend > 0 ? revenue / spend : 0;
    const threshold = p.threshold ?? (type === 'roas_above' ? 3 : 1.5);
    const hit = type === 'roas_above' ? roas >= threshold : roas <= threshold;
    if (hit) return { triggered: true, data: { roas: +roas.toFixed(2), threshold, window } };
    return { triggered: false };
  }

  if (type === 'adset_spend_above') {
    if (!p.adset_id) return { triggered: false };
    const snap = await MetricSnapshot.findOne({ entity_id: p.adset_id, entity_type: 'adset' })
      .sort({ snapshot_at: -1 }).lean();
    if (!snap) return { triggered: false };
    const spendToday = snap.metrics?.today?.spend || 0;
    const threshold = p.amount ?? 50;
    if (spendToday >= threshold)
      return { triggered: true, data: { adset: snap.entity_name, spend_today: Math.round(spendToday), threshold } };
    return { triggered: false };
  }

  if (type === 'adset_roas_above') {
    if (!p.adset_id) return { triggered: false };
    const snap = await MetricSnapshot.findOne({ entity_id: p.adset_id, entity_type: 'adset' })
      .sort({ snapshot_at: -1 }).lean();
    if (!snap) return { triggered: false };
    const window = p.window || 'last_7d';
    const roas = snap.metrics?.[window]?.roas || 0;
    const threshold = p.threshold ?? 3;
    if (roas >= threshold)
      return { triggered: true, data: { adset: snap.entity_name, roas: +roas.toFixed(2), threshold, window } };
    return { triggered: false };
  }

  if (type === 'test_graduates') {
    const since = watcher.created_at;
    const minCount = p.count ?? 1;
    const count = await TestRun.countDocuments({ graduated_at: { $gte: since } });
    if (count >= minCount)
      return { triggered: true, data: { graduated_since: count, threshold: minCount } };
    return { triggered: false };
  }

  if (type === 'test_count') {
    const count = await TestRun.countDocuments({ phase: { $in: ['learning', 'evaluating'] } });
    const op = p.op || 'gte';
    const threshold = p.threshold ?? 10;
    const hit = op === 'gte' ? count >= threshold : op === 'lte' ? count <= threshold : count === threshold;
    if (hit) return { triggered: true, data: { active_tests: count, threshold, op } };
    return { triggered: false };
  }

  return { triggered: false };
}

/**
 * Corre todos los watchers activos. Retorna los que dispararon + data.
 */
async function checkWatchers() {
  const now = new Date();
  const watchers = await ZeusWatcher.find({
    active: true,
    triggered_at: null,
    $or: [{ expires_at: null }, { expires_at: { $gt: now } }]
  }).lean();

  const triggered = [];
  for (const w of watchers) {
    try {
      const result = await evaluateCondition(w);
      if (result.triggered) {
        await ZeusWatcher.updateOne(
          { _id: w._id },
          { $set: { triggered_at: now, trigger_result: result.data, active: false } }
        );
        triggered.push({ watcher: w, data: result.data });
      }
    } catch (err) {
      logger.error(`[ZEUS-WATCHER] eval failed id=${w._id}: ${err.message}`);
    }
  }

  // Limpiar expired
  await ZeusWatcher.updateMany(
    { active: true, triggered_at: null, expires_at: { $lt: now } },
    { $set: { active: false } }
  );

  return triggered;
}

module.exports = { checkWatchers, evaluateCondition };
