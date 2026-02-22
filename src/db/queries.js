const MetricSnapshot = require('./models/MetricSnapshot');
const Decision = require('./models/Decision');
const ActionLog = require('./models/ActionLog');
const SafetyEvent = require('./models/SafetyEvent');
const SystemConfig = require('./models/SystemConfig');
const StrategicDirective = require('./models/StrategicDirective');

// ═══ METRIC SNAPSHOTS ═══

async function getLatestSnapshots(entityType = null) {
  const match = entityType ? { entity_type: entityType } : {};

  return MetricSnapshot.aggregate([
    { $match: match },
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    {
      $group: {
        _id: '$entity_id',
        doc: { $first: '$$ROOT' }
      }
    },
    { $replaceRoot: { newRoot: '$doc' } },
    { $sort: { entity_type: 1, entity_name: 1 } }
  ]);
}

async function getSnapshotHistory(entityId, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  return MetricSnapshot.find({
    entity_id: entityId,
    snapshot_at: { $gte: since }
  })
    .sort({ snapshot_at: 1 })
    .lean();
}

async function getAccountOverview() {
  const latestAdsets = await getLatestSnapshots('adset');

  const totalDailyBudget = latestAdsets.reduce((sum, s) => sum + (s.daily_budget || 0), 0);
  const todaySpend = latestAdsets.reduce((sum, s) => sum + (s.metrics?.today?.spend || 0), 0);
  const todayRevenue = latestAdsets.reduce((sum, s) => sum + (s.metrics?.today?.purchase_value || 0), 0);

  const spend7d = latestAdsets.reduce((sum, s) => sum + (s.metrics?.last_7d?.spend || 0), 0);
  const revenue7d = latestAdsets.reduce((sum, s) => sum + (s.metrics?.last_7d?.purchase_value || 0), 0);

  const spend3d = latestAdsets.reduce((sum, s) => sum + (s.metrics?.last_3d?.spend || 0), 0);
  const revenue3d = latestAdsets.reduce((sum, s) => sum + (s.metrics?.last_3d?.purchase_value || 0), 0);

  const spend14d = latestAdsets.reduce((sum, s) => sum + (s.metrics?.last_14d?.spend || 0), 0);
  const revenue14d = latestAdsets.reduce((sum, s) => sum + (s.metrics?.last_14d?.purchase_value || 0), 0);

  const spend30d = latestAdsets.reduce((sum, s) => sum + (s.metrics?.last_30d?.spend || 0), 0);
  const revenue30d = latestAdsets.reduce((sum, s) => sum + (s.metrics?.last_30d?.purchase_value || 0), 0);

  return {
    total_daily_budget: totalDailyBudget,
    today_spend: todaySpend,
    today_revenue: todayRevenue,
    today_roas: todaySpend > 0 ? todayRevenue / todaySpend : 0,
    roas_7d: spend7d > 0 ? revenue7d / spend7d : 0,
    roas_3d: spend3d > 0 ? revenue3d / spend3d : 0,
    roas_14d: spend14d > 0 ? revenue14d / spend14d : 0,
    roas_30d: spend30d > 0 ? revenue30d / spend30d : 0,
    spend_14d: spend14d,
    spend_30d: spend30d,
    active_adsets: latestAdsets.filter(s => s.status === 'ACTIVE').length,
    paused_adsets: latestAdsets.filter(s => s.status === 'PAUSED').length,
    total_adsets: latestAdsets.length
  };
}

async function getAdsForAdSet(adSetId) {
  return MetricSnapshot.aggregate([
    { $match: { entity_type: 'ad', parent_id: adSetId } },
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    {
      $group: {
        _id: '$entity_id',
        doc: { $first: '$$ROOT' }
      }
    },
    { $replaceRoot: { newRoot: '$doc' } },
    { $sort: { entity_name: 1 } }
  ]);
}

// ═══ DECISIONS ═══

async function getRecentDecisions(hours = 24) {
  const since = new Date();
  since.setHours(since.getHours() - hours);

  return Decision.find({ created_at: { $gte: since } })
    .sort({ created_at: -1 })
    .lean();
}

async function getDecisionsPaginated(page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const [decisions, total] = await Promise.all([
    Decision.find().sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
    Decision.countDocuments()
  ]);

  return { decisions, total, page, pages: Math.ceil(total / limit) };
}

async function getDecisionStats() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [todayStats, weekStats] = await Promise.all([
    Decision.aggregate([
      { $match: { created_at: { $gte: today } } },
      {
        $group: {
          _id: null,
          total_cycles: { $sum: 1 },
          total_actions: { $sum: '$total_actions' },
          approved: { $sum: '$approved_actions' },
          executed: { $sum: '$executed_actions' }
        }
      }
    ]),
    Decision.aggregate([
      { $match: { created_at: { $gte: weekAgo } } },
      {
        $group: {
          _id: null,
          total_cycles: { $sum: 1 },
          total_actions: { $sum: '$total_actions' },
          approved: { $sum: '$approved_actions' },
          executed: { $sum: '$executed_actions' }
        }
      }
    ])
  ]);

  return {
    today: todayStats[0] || { total_cycles: 0, total_actions: 0, approved: 0, executed: 0 },
    week: weekStats[0] || { total_cycles: 0, total_actions: 0, approved: 0, executed: 0 }
  };
}

// ═══ ACTION LOG ═══

async function getActionsPaginated(page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const [actions, total] = await Promise.all([
    ActionLog.find().sort({ executed_at: -1 }).skip(skip).limit(limit).lean(),
    ActionLog.countDocuments()
  ]);

  return { actions, total, page, pages: Math.ceil(total / limit) };
}

async function getActionsForEntity(entityId, limit = 50) {
  return ActionLog.find({ entity_id: entityId })
    .sort({ executed_at: -1 })
    .limit(limit)
    .lean();
}

async function getTodaysBudgetChanges() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return ActionLog.find({
    action: { $in: ['scale_up', 'scale_down'] },
    executed_at: { $gte: today },
    success: true
  }).lean();
}

async function getRecentActions(days = 3) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  return ActionLog.find({
    executed_at: { $gte: since },
    success: true
  })
    .sort({ executed_at: -1 })
    .lean();
}

async function getExecutedActionsWithImpact(limit = 50) {
  return ActionLog.find({
    success: true,
    impact_measured: true
  })
    .sort({ executed_at: -1 })
    .limit(limit)
    .lean();
}

async function getPendingImpactMeasurement() {
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  return ActionLog.find({
    success: true,
    impact_measured: false,
    executed_at: { $lte: threeDaysAgo }
  }).lean();
}

async function getPending1dImpactMeasurement() {
  const oneDayAgo = new Date();
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);

  return ActionLog.find({
    success: true,
    impact_1d_measured: { $ne: true },
    executed_at: { $lte: oneDayAgo }
  }).lean();
}

async function getPending7dImpactMeasurement() {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  return ActionLog.find({
    success: true,
    impact_measured: true,
    impact_7d_measured: { $ne: true },
    executed_at: { $lte: sevenDaysAgo }
  }).lean();
}

async function getPendingLearningActions(limit = 200) {
  const learnableActions = [
    'scale_up', 'scale_down', 'pause', 'reactivate',
    'duplicate_adset', 'create_ad', 'update_bid_strategy',
    'update_ad_status', 'move_budget', 'update_ad_creative'
  ];

  // Phase 1: Actions with 3d data that haven't been learned at all
  const newLearning = await ActionLog.find({
    success: true,
    impact_measured: true,
    action: { $in: learnableActions },
    $or: [
      { learned_at: null },
      { learned_at: { $exists: false } }
    ]
  })
    .sort({ impact_measured_at: 1, executed_at: 1 })
    .limit(limit)
    .lean();

  // Phase 2: Actions with 7d data that were learned with 3d data — re-learn with better signal
  const remainingLimit = Math.max(0, limit - newLearning.length);
  let relearn = [];
  if (remainingLimit > 0) {
    relearn = await ActionLog.find({
      success: true,
      impact_7d_measured: true,
      learned_7d_at: { $exists: false }, // Not yet re-learned with 7d
      learned_at: { $exists: true, $ne: null }, // Was learned with 3d
      action: { $in: learnableActions }
    })
      .sort({ impact_7d_measured_at: 1 })
      .limit(remainingLimit)
      .lean();

    // Mark these as re-learn so the learner knows
    relearn = relearn.map(a => ({ ...a, _is_7d_relearn: true }));
  }

  return [...newLearning, ...relearn];
}

// ═══ SAFETY EVENTS ═══

async function getUnresolvedSafetyEvents() {
  return SafetyEvent.find({ resolved: false })
    .sort({ created_at: -1 })
    .lean();
}

async function isKillSwitchActive() {
  const event = await SafetyEvent.findOne({
    event_type: 'kill_switch_triggered',
    resolved: false
  }).lean();

  return !!event;
}

// ═══ SISTEMA ═══

async function isAIEnabled() {
  return SystemConfig.get('ai_enabled', false);
}

async function setAIEnabled(enabled, updatedBy = 'system') {
  return SystemConfig.set('ai_enabled', !!enabled, updatedBy);
}

// ═══ STRATEGIC DIRECTIVES ═══

async function getActiveDirectives() {
  return StrategicDirective.find({
    status: 'active',
    expires_at: { $gt: new Date() }
  }).lean();
}

async function getLatestPolicyDecisions() {
  const latest = await Decision.findOne()
    .sort({ created_at: -1 })
    .lean();
  if (!latest) return [];
  return (latest.decisions || []).map(d => ({
    action: d.action,
    entity_type: d.entity_type,
    entity_id: d.entity_id,
    entity_name: d.entity_name,
    current_value: d.current_value,
    new_value: d.new_value,
    change_percent: d.change_percent,
    reasoning: d.reasoning,
    confidence: d.confidence,
    policy_score: d.policy_score,
    recommendation_status: d.recommendation_status,
    decision_category: d.decision_category
  }));
}

// ═══ OVERVIEW HISTORY (para gráficos de tendencia) ═══

async function getOverviewHistory(days = 7) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // Agrupar snapshots de adsets por día, tomando el último snapshot de cada adset por día
  const dailyData = await MetricSnapshot.aggregate([
    {
      $match: {
        entity_type: 'adset',
        snapshot_at: { $gte: since }
      }
    },
    {
      $addFields: {
        date_str: { $dateToString: { format: '%Y-%m-%d', date: '$snapshot_at' } }
      }
    },
    // Último snapshot de cada adset por día
    { $sort: { entity_id: 1, snapshot_at: -1 } },
    {
      $group: {
        _id: { date: '$date_str', entity_id: '$entity_id' },
        doc: { $first: '$$ROOT' }
      }
    },
    { $replaceRoot: { newRoot: '$doc' } },
    // Agrupar todos los adsets por día para calcular totales
    {
      $group: {
        _id: '$date_str',
        spend_today: { $sum: { $ifNull: ['$metrics.today.spend', 0] } },
        revenue_today: { $sum: { $ifNull: ['$metrics.today.purchase_value', 0] } },
        spend_7d: { $sum: { $ifNull: ['$metrics.last_7d.spend', 0] } },
        revenue_7d: { $sum: { $ifNull: ['$metrics.last_7d.purchase_value', 0] } },
        spend_3d: { $sum: { $ifNull: ['$metrics.last_3d.spend', 0] } },
        revenue_3d: { $sum: { $ifNull: ['$metrics.last_3d.purchase_value', 0] } }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  return dailyData.map(d => ({
    date: d._id,
    spend: d.spend_today,
    revenue: d.revenue_today,
    roas_7d: d.spend_7d > 0 ? +(d.revenue_7d / d.spend_7d).toFixed(2) : 0,
    roas_3d: d.spend_3d > 0 ? +(d.revenue_3d / d.spend_3d).toFixed(2) : 0
  }));
}

// ═══ LIMPIEZA ═══

async function cleanupOldSnapshots(daysToKeep = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysToKeep);

  const result = await MetricSnapshot.deleteMany({ snapshot_at: { $lt: cutoff } });
  return result.deletedCount;
}

module.exports = {
  getLatestSnapshots,
  getSnapshotHistory,
  getAccountOverview,
  getAdsForAdSet,
  getRecentDecisions,
  getDecisionsPaginated,
  getDecisionStats,
  getActionsPaginated,
  getActionsForEntity,
  getTodaysBudgetChanges,
  getRecentActions,
  getExecutedActionsWithImpact,
  getPendingImpactMeasurement,
  getPending1dImpactMeasurement,
  getPending7dImpactMeasurement,
  getPendingLearningActions,
  getUnresolvedSafetyEvents,
  isKillSwitchActive,
  isAIEnabled,
  setAIEnabled,
  cleanupOldSnapshots,
  getActiveDirectives,
  getLatestPolicyDecisions,
  getOverviewHistory
};
