require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 5 });
  const MS = mongoose.connection.db.collection('metricsnapshots');
  const AL = mongoose.connection.db.collection('actionlogs');
  const TR = mongoose.connection.db.collection('testruns');
  const now = Date.now();
  const DAY = 86400000;

  console.log('\n============ ATHENA SCALING STRATEGY EVALUATION ============\n');

  // Todos los graduados (incluso pausados/eliminados)
  const allGraduates = await TR.find({ phase: 'graduated' }).toArray();
  console.log('═══ UNIVERSO DE GRADUADOS HISTORICOS ═══');
  console.log('Total graduados desde inicio: ' + allGraduates.length);

  // Buscar el ultimo snapshot por entity_id para cada uno
  const graduateIds = allGraduates.map(g => g.test_adset_id).filter(Boolean);

  const lastSnaps = await MS.aggregate([
    { $match: { entity_type: 'adset', entity_id: { $in: graduateIds } } },
    { $sort: { snapshot_at: -1 } },
    { $group: {
      _id: '$entity_id',
      name: { $first: '$entity_name' },
      status: { $first: '$status' },
      learning_stage: { $first: '$learning_stage' },
      learning_conv: { $first: '$learning_stage_conversions' },
      roas_7d: { $first: '$metrics.last_7d.roas' },
      roas_3d: { $first: '$metrics.last_3d.roas' },
      spend_7d: { $first: '$metrics.last_7d.spend' },
      daily_budget: { $first: '$daily_budget' },
      snap_at: { $first: '$snapshot_at' }
    }}
  ]).toArray();

  // Tabular por edad desde graduacion
  const enriched = lastSnaps.map(s => {
    const grad = allGraduates.find(g => g.test_adset_id === s._id);
    const graduatedAt = grad?.graduated_at;
    const ageDays = graduatedAt ? Math.floor((now - new Date(graduatedAt).getTime()) / DAY) : null;
    return { ...s, graduated_at: graduatedAt, ageDays };
  }).sort((a, b) => (a.ageDays || 999) - (b.ageDays || 999));

  // Buckets por edad
  const recent = enriched.filter(e => e.ageDays != null && e.ageDays <= 5);
  const week1 = enriched.filter(e => e.ageDays > 5 && e.ageDays <= 12);
  const older = enriched.filter(e => e.ageDays > 12);

  function summarize(group, label) {
    if (group.length === 0) return;
    const inLearn = group.filter(g => g.learning_stage === 'LEARNING').length;
    const inSuccess = group.filter(g => g.learning_stage === 'SUCCESS').length;
    const inFail = group.filter(g => g.learning_stage === 'FAIL').length;
    const stillActive = group.filter(g => g.status === 'ACTIVE').length;
    const paused = group.filter(g => g.status === 'PAUSED').length;
    const deleted = group.filter(g => g.status === 'DELETED' || g.status === 'ARCHIVED').length;
    console.log(`\n  ${label} (${group.length} graduados):`);
    console.log(`    Estado:     ACTIVE=${stillActive}  PAUSED=${paused}  DELETED=${deleted}`);
    console.log(`    Learning:   LEARNING=${inLearn}  SUCCESS=${inSuccess}  FAIL=${inFail}  null=${group.length - inLearn - inSuccess - inFail}`);
    if (group.length > 0) {
      const avgRoas = group.reduce((s, g) => s + (g.roas_7d || 0), 0) / group.length;
      const avgConv = group.reduce((s, g) => s + (g.learning_conv || 0), 0) / group.length;
      console.log(`    Promedio:   ROAS_7d=${avgRoas.toFixed(2)}x  conv_acumuladas=${avgConv.toFixed(0)}/50`);
    }
  }

  console.log('\n═══ ESTADO POR EDAD DESDE GRADUACION ═══');
  summarize(recent, 'RECIENTES (0-5 dias)');
  summarize(week1, 'SEMANA 1-2 (6-12 dias)');
  summarize(older, 'VIEJOS (13+ dias)');

  // Para graduados de mas de 7 dias, ¿salieron de learning?
  const eligible7d = enriched.filter(e => e.ageDays != null && e.ageDays >= 7);
  const exited = eligible7d.filter(e => e.learning_stage === 'SUCCESS' || e.learning_stage === 'FAIL');
  console.log('\n═══ EXIT RATE DE LEARNING (>= 7 dias post-graduacion) ═══');
  console.log(`  Eligible (>= 7d): ${eligible7d.length}`);
  console.log(`  Salieron de learning: ${exited.length} (${((exited.length/(eligible7d.length||1))*100).toFixed(0)}%)`);
  console.log(`  Aun en LEARNING despues de 7+ dias: ${eligible7d.length - exited.length}`);

  // Detalle de los que llevan +7d en learning
  const stuck = eligible7d.filter(e => e.learning_stage === 'LEARNING');
  if (stuck.length > 0) {
    console.log('\n  Graduados estancados >= 7d en LEARNING (top 10 por edad):');
    stuck.slice(0, 10).forEach(s => {
      console.log(`    ${s.ageDays}d  conv=${s.learning_conv||0}/50  ROAS=${(s.roas_7d||0).toFixed(2)}x  budget=$${s.daily_budget||0}/d  status=${s.status}  "${(s.name||'').substring(0, 45)}"`);
    });
  }

  // Para los SUCCESS, cuanto tardaron en salir?
  const successList = enriched.filter(e => e.learning_stage === 'SUCCESS' && e.graduated_at);
  console.log('\n═══ GRADUADOS QUE LLEGARON A SUCCESS ═══');
  console.log('  Total: ' + successList.length);
  if (successList.length > 0) {
    successList.slice(0, 5).forEach(s => {
      console.log(`    "${(s.name||'').substring(0,45)}"  ${s.ageDays}d post-grad  ROAS=${(s.roas_7d||0).toFixed(2)}x  budget=$${s.daily_budget}/d`);
    });
  }

  // Cuantas escaladas en promedio antes de salir / antes de morir
  console.log('\n═══ ESCALADAS POR GRADUADO (top 10 mas escalados) ═══');
  const scalesPerEntity = await AL.aggregate([
    { $match: { agent_type: 'unified_agent', action: 'scale_up', entity_id: { $in: graduateIds } } },
    { $group: { _id: '$entity_id', scales: { $sum: 1 }, name: { $first: '$entity_name' } } },
    { $sort: { scales: -1 } },
    { $limit: 10 }
  ]).toArray();
  scalesPerEntity.forEach(s => {
    const e = enriched.find(x => x._id === s._id);
    const stage = e?.learning_stage || '?';
    const conv = e?.learning_conv || 0;
    const ageDays = e?.ageDays || '?';
    const roas = e?.roas_7d || 0;
    console.log(`  "${(s.name||'').substring(0,40)}"  ${s.scales} scales | ${ageDays}d post-grad | conv=${conv}/50 | ROAS=${roas.toFixed(2)}x | ${stage}`);
  });

  // Edad media de cada bucket
  console.log('\n═══ EDAD DE LOS GRADUADOS ACTUALES ═══');
  const ageBuckets = { '0-2d': 0, '3-5d': 0, '6-9d': 0, '10-14d': 0, '15+d': 0 };
  enriched.forEach(e => {
    if (e.ageDays == null) return;
    if (e.ageDays <= 2) ageBuckets['0-2d']++;
    else if (e.ageDays <= 5) ageBuckets['3-5d']++;
    else if (e.ageDays <= 9) ageBuckets['6-9d']++;
    else if (e.ageDays <= 14) ageBuckets['10-14d']++;
    else ageBuckets['15+d']++;
  });
  Object.entries(ageBuckets).forEach(([k, v]) => console.log(`  ${k.padEnd(8)} ${v} graduados`));

  await mongoose.disconnect();
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
