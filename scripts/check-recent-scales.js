require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 5 });
  const AL = mongoose.connection.db.collection('actionlogs');
  const ZD = mongoose.connection.db.collection('zeusdirectives');

  const now = Date.now();
  const HRS = 3600000;

  console.log('\n═══ DIRECTIVAS ACTIVAS DE ATHENA (avoid) ═══');
  const dirs = await ZD.find({
    active: true,
    directive_type: 'avoid',
    $or: [{ target_agent: 'athena' }, { target_agent: 'all' }],
    $and: [{ $or: [{ expires_at: null }, { expires_at: { $gt: new Date() } }] }]
  }).toArray();

  for (const d of dirs) {
    const ageH = Math.round((now - new Date(d.created_at).getTime()) / HRS);
    console.log(`  · [${d.target_agent}] ${ageH}h atrás · scope=${JSON.stringify(d.action_scope || 'null')}`);
    console.log(`    "${d.directive.substring(0, 100)}${d.directive.length > 100 ? '…' : ''}"`);
  }
  if (dirs.length === 0) console.log('  (ninguna activa)');

  console.log('\n═══ ACTIONS DE ATHENA ÚLTIMAS 24H ═══');
  const since = new Date(now - 24 * HRS);
  const actions = await AL.find({
    agent_type: { $in: ['unified_agent', 'account_agent', 'athena'] },
    executed_at: { $gte: since }
  }).sort({ executed_at: -1 }).toArray();

  const byAction = {};
  for (const a of actions) {
    byAction[a.action] = (byAction[a.action] || 0) + 1;
  }
  console.log('  Conteo por tipo:', byAction);

  const scales = actions.filter(a => a.action === 'scale_up' || a.action === 'scale_down');
  console.log(`\n  Scales en detalle (${scales.length}):`);
  for (const s of scales) {
    const hAgo = Math.round((now - new Date(s.executed_at).getTime()) / HRS * 10) / 10;
    console.log(`  · ${s.action} · ${s.entity_name || s.entity_id} · $${s.before_value} → $${s.after_value} (${s.change_percent}%) · ${hAgo}h atrás`);
    if (s.reasoning) console.log(`    razón: "${s.reasoning.substring(0, 120)}"`);
  }

  console.log('\n═══ TODOS los ACTIONS últimos 24h (resumen 1-line c/u) ═══');
  for (const a of actions.slice(0, 30)) {
    const hAgo = Math.round((now - new Date(a.executed_at).getTime()) / HRS * 10) / 10;
    console.log(`  ${hAgo.toString().padStart(5)}h ago · ${a.action.padEnd(15)} · ${a.entity_name || a.entity_id}`);
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('ERR:', err);
  process.exit(1);
});
