require('dotenv').config();
const mongoose = require('mongoose');
const ActionLog = require('../src/db/models/ActionLog');
const SystemConfig = require('../src/db/models/SystemConfig');
const config = require('../config');

async function main() {
  await mongoose.connect(config.mongodb.uri, { maxPoolSize: 5 });

  console.log('\n========== AUDITORIA LEARNING LOOP ==========\n');

  const now = Date.now();
  const DAY = 86400000;

  // ---- 1. Universo de ActionLogs ----
  const total = await ActionLog.countDocuments({});
  const successful = await ActionLog.countDocuments({ success: true });
  const learnableActions = [
    'scale_up', 'scale_down', 'pause', 'reactivate',
    'duplicate_adset', 'create_ad', 'update_bid_strategy',
    'update_ad_status', 'move_budget', 'update_ad_creative'
  ];
  const learnable = await ActionLog.countDocuments({
    success: true,
    action: { $in: learnableActions }
  });

  console.log('UNIVERSO');
  console.log(`  Total ActionLogs:           ${total}`);
  console.log(`  Exitosas (success:true):    ${successful}`);
  console.log(`  Acciones aprendibles:       ${learnable}`);

  // ---- 2. Impact measurement ----
  const age1d = await ActionLog.countDocuments({
    success: true, action: { $in: learnableActions },
    executed_at: { $lte: new Date(now - 1 * DAY) }
  });
  const age3d = await ActionLog.countDocuments({
    success: true, action: { $in: learnableActions },
    executed_at: { $lte: new Date(now - 3 * DAY) }
  });
  const age7d = await ActionLog.countDocuments({
    success: true, action: { $in: learnableActions },
    executed_at: { $lte: new Date(now - 7 * DAY) }
  });

  const measured1d = await ActionLog.countDocuments({
    success: true, action: { $in: learnableActions },
    impact_1d_measured: true
  });
  const measured3d = await ActionLog.countDocuments({
    success: true, action: { $in: learnableActions },
    impact_measured: true
  });
  const measured7d = await ActionLog.countDocuments({
    success: true, action: { $in: learnableActions },
    impact_7d_measured: true
  });

  console.log('\nIMPACT MEASUREMENT');
  console.log(`  Acciones con edad >=1d:     ${age1d}  →  medidas: ${measured1d} (${pct(measured1d, age1d)}%)`);
  console.log(`  Acciones con edad >=3d:     ${age3d}  →  medidas: ${measured3d} (${pct(measured3d, age3d)}%)`);
  console.log(`  Acciones con edad >=7d:     ${age7d}  →  medidas: ${measured7d} (${pct(measured7d, age7d)}%)`);

  // ---- 3. Learned state ----
  const learned = await ActionLog.countDocuments({
    success: true, action: { $in: learnableActions },
    learned_at: { $ne: null }
  });
  const learned7d = await ActionLog.countDocuments({
    success: true, action: { $in: learnableActions },
    learned_7d_at: { $exists: true, $ne: null }
  });
  const pendingLearn = await ActionLog.countDocuments({
    success: true, impact_measured: true,
    action: { $in: learnableActions },
    $or: [{ learned_at: null }, { learned_at: { $exists: false } }]
  });
  const pendingRelearn = await ActionLog.countDocuments({
    success: true, impact_7d_measured: true,
    action: { $in: learnableActions },
    learned_at: { $exists: true, $ne: null },
    learned_7d_at: { $exists: false }
  });

  console.log('\nLEARNING STATE');
  console.log(`  Aprendidas (3d reward):     ${learned}`);
  console.log(`  Re-aprendidas (7d reward):  ${learned7d}`);
  console.log(`  PENDING learn (3d data):    ${pendingLearn}  ${pendingLearn > 0 ? '⚠️' : ''}`);
  console.log(`  PENDING relearn (7d):       ${pendingRelearn}  ${pendingRelearn > 0 ? '⚠️' : ''}`);

  // ---- 4. Last learned timestamp ----
  const lastLearned = await ActionLog.findOne({
    learned_at: { $ne: null }
  }).sort({ learned_at: -1 }).select('learned_at').lean();
  const firstLearned = await ActionLog.findOne({
    learned_at: { $ne: null }
  }).sort({ learned_at: 1 }).select('learned_at').lean();

  console.log('\nACTIVIDAD DEL LOOP');
  if (lastLearned) {
    const hoursAgo = (now - new Date(lastLearned.learned_at).getTime()) / 3600000;
    console.log(`  Ultima aprendizaje:         ${lastLearned.learned_at.toISOString()}  (hace ${hoursAgo.toFixed(1)}h)`);
  } else {
    console.log(`  Ultima aprendizaje:         NUNCA`);
  }
  if (firstLearned) {
    console.log(`  Primer aprendizaje:         ${firstLearned.learned_at.toISOString()}`);
  }

  // ---- 5. Reward distribution ----
  const rewardAgg = await ActionLog.aggregate([
    { $match: { learned_reward: { $ne: null } } },
    { $group: {
      _id: null,
      count: { $sum: 1 },
      avg: { $avg: '$learned_reward' },
      min: { $min: '$learned_reward' },
      max: { $max: '$learned_reward' },
      pos: { $sum: { $cond: [{ $gt: ['$learned_reward', 0.05] }, 1, 0] } },
      neg: { $sum: { $cond: [{ $lt: ['$learned_reward', -0.05] }, 1, 0] } },
      neutral: { $sum: { $cond: [{ $and: [
        { $gte: ['$learned_reward', -0.05] },
        { $lte: ['$learned_reward', 0.05] }
      ] }, 1, 0] } }
    }}
  ]);

  console.log('\nREWARD DISTRIBUTION');
  if (rewardAgg.length) {
    const r = rewardAgg[0];
    console.log(`  Muestras:                   ${r.count}`);
    console.log(`  Reward medio:               ${r.avg.toFixed(4)}`);
    console.log(`  Min / Max:                  ${r.min.toFixed(3)} / ${r.max.toFixed(3)}`);
    console.log(`  Positivas (>+0.05):         ${r.pos} (${pct(r.pos, r.count)}%)`);
    console.log(`  Neutras (-0.05..+0.05):     ${r.neutral} (${pct(r.neutral, r.count)}%)`);
    console.log(`  Negativas (<-0.05):         ${r.neg} (${pct(r.neg, r.count)}%)`);
  }

  // ---- 6. Reward by action type ----
  const byAction = await ActionLog.aggregate([
    { $match: { learned_reward: { $ne: null } } },
    { $group: {
      _id: '$action',
      count: { $sum: 1 },
      avg: { $avg: '$learned_reward' }
    }},
    { $sort: { count: -1 } }
  ]);

  console.log('\nREWARD POR ACTION TYPE');
  byAction.forEach(a => {
    console.log(`  ${a._id.padEnd(22)} n=${String(a.count).padStart(4)}  avg=${a.avg.toFixed(4)}`);
  });

  // ---- 7. Thompson Sampling state ----
  const tsState = await SystemConfig.get('unified_policy_learning_v1');
  console.log('\nTHOMPSON SAMPLING STATE (SystemConfig)');
  if (tsState && typeof tsState === 'object') {
    console.log(`  Version:                    ${tsState.version || '?'}`);
    console.log(`  Total samples:              ${tsState.total_samples || 0}`);
    console.log(`  Updated at:                 ${tsState.updated_at || 'never'}`);
    const bucketKeys = Object.keys(tsState.buckets || {});
    console.log(`  Buckets populados:          ${bucketKeys.length}`);
    if (bucketKeys.length > 0) {
      console.log(`\n  TOP 5 buckets por muestras:`);
      const bucketRanked = bucketKeys.map(k => {
        const bucket = tsState.buckets[k];
        const totalCount = Object.values(bucket).reduce((s, a) => s + (a.count || 0), 0);
        const actions = Object.keys(bucket).length;
        return { bucket: k, count: totalCount, actions };
      }).sort((a, b) => b.count - a.count).slice(0, 5);
      bucketRanked.forEach(b => {
        console.log(`    ${b.bucket}  n=${b.count}  actions=${b.actions}`);
      });
    }
  } else {
    console.log('  NO STATE ENCONTRADO ⚠️');
  }

  // ---- 8. Follow-up verdict (el campo que el vault confundio) ----
  const verdictAgg = await ActionLog.aggregate([
    { $match: { success: true, action: { $in: learnableActions } } },
    { $group: { _id: '$follow_up_verdict', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);
  console.log('\nFOLLOW_UP_VERDICT (separado del learned_reward)');
  verdictAgg.forEach(v => {
    console.log(`  ${String(v._id || 'null').padEnd(15)} ${v.count}`);
  });

  // ---- 9. Recent ActionLogs (sanity check) ----
  console.log('\nULTIMAS 5 ACCIONES');
  const recent = await ActionLog.find({ success: true, action: { $in: learnableActions } })
    .sort({ executed_at: -1 })
    .limit(5)
    .select('action entity_name executed_at impact_measured impact_7d_measured learned_at learned_reward follow_up_verdict')
    .lean();
  recent.forEach(a => {
    const age = ((now - new Date(a.executed_at).getTime()) / 3600000).toFixed(1);
    console.log(`  ${a.action.padEnd(18)} ${age}h ago  3d=${a.impact_measured?'Y':'N'} 7d=${a.impact_7d_measured?'Y':'N'} learned=${a.learned_at?'Y':'N'} reward=${a.learned_reward != null ? a.learned_reward.toFixed(3) : '-'}`);
  });

  console.log('\n==============================================\n');

  await mongoose.disconnect();
}

function pct(a, b) {
  if (!b) return '0.0';
  return ((a / b) * 100).toFixed(1);
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
