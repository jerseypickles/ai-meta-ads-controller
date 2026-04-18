require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 5 });

  const AL = mongoose.connection.db.collection('actionlogs');
  const MS = mongoose.connection.db.collection('metricsnapshots');
  const now = Date.now();
  const DAY = 86400000;

  console.log('\n============ AUDITORIA ATHENA SCALING ============\n');

  // ═══════════════════════════════════════════════════════════════════
  // 1. ACCOUNT-LEVEL ROAS — tendencia ultimos 14 dias
  // ═══════════════════════════════════════════════════════════════════
  console.log('═══ 1. ACCOUNT-LEVEL ROAS POR DIA (14d) ═══');
  console.log('  Si Athena escala bien, ROAS se mantiene o sube. Si destruye valor, baja consistente.\n');

  const accountDaily = await MS.aggregate([
    { $match: { entity_type: 'account', snapshot_at: { $gte: new Date(now - 14*DAY) } } },
    { $group: {
      _id: { $dateToString: { format: '%Y-%m-%d', date: '$snapshot_at' } },
      roas_7d: { $last: '$metrics.last_7d.roas' },
      spend_7d: { $last: '$metrics.last_7d.spend' },
      revenue_7d: { $last: '$metrics.last_7d.purchase_value' },
      purchases_7d: { $last: '$metrics.last_7d.purchases' }
    }},
    { $sort: { _id: 1 } }
  ]).toArray();

  if (accountDaily.length === 0) {
    // Fallback: agregar adset-level
    const adsetDaily = await MS.aggregate([
      { $match: { entity_type: 'adset', snapshot_at: { $gte: new Date(now - 14*DAY) } } },
      { $sort: { entity_id: 1, snapshot_at: -1 } },
      { $group: {
        _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$snapshot_at' } }, entity_id: '$entity_id' },
        spend: { $first: '$metrics.last_7d.spend' },
        revenue: { $first: '$metrics.last_7d.purchase_value' },
        purchases: { $first: '$metrics.last_7d.purchases' }
      }},
      { $group: {
        _id: '$_id.day',
        spend_7d: { $sum: '$spend' },
        revenue_7d: { $sum: '$revenue' },
        purchases_7d: { $sum: '$purchases' }
      }},
      { $sort: { _id: 1 } }
    ]).toArray();
    adsetDaily.forEach(d => {
      const roas = d.spend_7d > 0 ? d.revenue_7d / d.spend_7d : 0;
      const cpa = d.purchases_7d > 0 ? d.spend_7d / d.purchases_7d : 0;
      console.log(`  ${d._id}  ROAS_7d=${roas.toFixed(2)}x  spend_7d=$${d.spend_7d.toFixed(0)}  rev=$${d.revenue_7d.toFixed(0)}  purch=${d.purchases_7d}  CPA=$${cpa.toFixed(2)}`);
    });
  } else {
    accountDaily.forEach(d => {
      const cpa = d.purchases_7d > 0 ? d.spend_7d / d.purchases_7d : 0;
      console.log(`  ${d._id}  ROAS_7d=${(d.roas_7d||0).toFixed(2)}x  spend_7d=$${(d.spend_7d||0).toFixed(0)}  rev=$${(d.revenue_7d||0).toFixed(0)}  purch=${d.purchases_7d}  CPA=$${cpa.toFixed(2)}`);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 2. ¿GRADUADOS SATURADOS?
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══ 2. GRADUADOS [Prometheus] — saturacion ═══');
  console.log('  Frecuencia > 3.0 = audiencia agotada. ROAS bajando 7d→3d = decline.\n');

  const graduates = await MS.aggregate([
    { $match: { entity_type: 'adset', status: 'ACTIVE', entity_name: { $regex: '\\[Prometheus\\]' } } },
    { $sort: { snapshot_at: -1 } },
    { $group: {
      _id: '$entity_id',
      name: { $first: '$entity_name' },
      roas_7d: { $first: '$metrics.last_7d.roas' },
      roas_3d: { $first: '$metrics.last_3d.roas' },
      frequency: { $first: '$metrics.last_7d.frequency' },
      spend_7d: { $first: '$metrics.last_7d.spend' },
      daily_budget: { $first: '$daily_budget' },
      learning_stage: { $first: '$learning_stage' },
      learning_conv: { $first: '$learning_stage_conversions' }
    }},
    { $sort: { spend_7d: -1 } }
  ]).toArray();

  let saturatedCount = 0;
  let learningCount = 0;
  let healthyCount = 0;
  let flagged = 0;

  console.log('  ' + 'NOMBRE'.padEnd(45) + 'BUDGET   ROAS_7d  ROAS_3d  FREQ  STAGE        FLAG');
  graduates.slice(0, 20).forEach(g => {
    const trendPct = (g.roas_7d > 0 && g.roas_3d > 0) ? ((g.roas_3d - g.roas_7d) / g.roas_7d * 100) : 0;
    const isSaturated = (g.frequency || 0) > 3.0;
    const isDeclining = trendPct < -20;
    const isLearning = g.learning_stage === 'LEARNING';
    let flag = '';
    if (isSaturated && isDeclining) { flag = 'SATURATED+DECLINE'; saturatedCount++; flagged++; }
    else if (isSaturated) { flag = 'saturated (freq>3)'; saturatedCount++; flagged++; }
    else if (isDeclining) { flag = 'declining 3d'; flagged++; }
    else if (isLearning) { flag = 'learning ' + (g.learning_conv||0) + '/50'; learningCount++; }
    else { flag = 'OK'; healthyCount++; }
    const name = (g.name || '?').substring(0, 43).padEnd(45);
    console.log(`  ${name}$${String(Math.round(g.daily_budget||0)).padStart(4)}/d  ${(g.roas_7d||0).toFixed(2)}x   ${(g.roas_3d||0).toFixed(2)}x    ${(g.frequency||0).toFixed(2)} ${(g.learning_stage||'?').padEnd(10)} ${flag}`);
  });
  console.log(`\n  Resumen: ${graduates.length} graduados | ${healthyCount} OK | ${learningCount} en learning | ${flagged} flagged`);

  // ═══════════════════════════════════════════════════════════════════
  // 3. ¿ESCALADAS REPETIDAS DESPUES DE REWARD NEGATIVO?
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══ 3. ESCALADAS DESPUES DE REWARD NEGATIVO ═══');
  console.log('  Si Athena escala 2 veces consecutivas con reward negativo, está siendo ciega.\n');

  // Para cada entity, traer todas las scale_up de Athena ordenadas por fecha
  const allScaleUps = await AL.find({
    agent_type: 'unified_agent',
    action: 'scale_up',
    success: true,
    executed_at: { $gte: new Date(now - 14*DAY) }
  }).sort({ entity_id: 1, executed_at: 1 }).toArray();

  const byEntity = {};
  allScaleUps.forEach(a => {
    if (!byEntity[a.entity_id]) byEntity[a.entity_id] = [];
    byEntity[a.entity_id].push(a);
  });

  let blindRepeats = 0;
  let learnedAndStopped = 0;
  let okScales = 0;
  const blindEntities = [];

  for (const [entityId, scales] of Object.entries(byEntity)) {
    if (scales.length < 2) continue;
    for (let i = 1; i < scales.length; i++) {
      const prev = scales[i-1];
      const curr = scales[i];
      const hoursBetween = (new Date(curr.executed_at) - new Date(prev.executed_at)) / 3600000;
      const prevReward = prev.learned_reward;

      if (prevReward != null && prevReward < -0.05) {
        // Escaló DESPUES de un reward negativo
        blindRepeats++;
        blindEntities.push({
          name: curr.entity_name,
          prevReward,
          hoursBetween: hoursBetween.toFixed(0),
          prevDate: prev.executed_at?.toISOString().substring(0, 10),
          currDate: curr.executed_at?.toISOString().substring(0, 10)
        });
      } else if (prevReward != null && prevReward > 0.05) {
        okScales++;
      }
    }
  }

  // Tambien: ¿después de un reward negativo, Athena DEJÓ de escalar?
  const allEntityScales = Object.entries(byEntity);
  for (const [entityId, scales] of allEntityScales) {
    const lastNegativeIdx = scales.findIndex(s => s.learned_reward != null && s.learned_reward < -0.05);
    if (lastNegativeIdx >= 0 && lastNegativeIdx === scales.length - 1) {
      learnedAndStopped++;
    }
  }

  console.log(`  Escaladas ciegas (despues de reward negativo): ${blindRepeats}`);
  console.log(`  Casos donde Athena paro tras reward negativo:  ${learnedAndStopped}`);
  console.log(`  Escaladas con prev reward POSITIVO:            ${okScales}`);

  if (blindEntities.length > 0) {
    console.log('\n  Top 10 escaladas ciegas:');
    blindEntities.slice(0, 10).forEach(b => {
      console.log(`    "${(b.name||'?').substring(0,45)}"  prev_reward=${b.prevReward.toFixed(3)}  ${b.prevDate} → ${b.currDate} (${b.hoursBetween}h gap)`);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 4. LEARNING PHASE — ¿las escaladas ayudan a salir?
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══ 4. ESCALADO + LEARNING PHASE ═══');
  console.log('  Si Athena escala graduados en LEARNING, deberian salir mas rapido.\n');

  const learningGraduates = graduates.filter(g => g.learning_stage === 'LEARNING');
  const successGraduates = graduates.filter(g => g.learning_stage === 'SUCCESS');
  const failGraduates = graduates.filter(g => g.learning_stage === 'FAIL');

  console.log(`  Graduados en LEARNING:  ${learningGraduates.length}`);
  console.log(`  Graduados en SUCCESS:   ${successGraduates.length}`);
  console.log(`  Graduados en FAIL:      ${failGraduates.length}`);

  // De los SUCCESS, cuantos fueron escalados por Athena?
  let scaledThenSuccess = 0;
  for (const g of successGraduates) {
    const wasScaled = await AL.countDocuments({
      entity_id: g._id, agent_type: 'unified_agent', action: 'scale_up'
    });
    if (wasScaled > 0) scaledThenSuccess++;
  }
  console.log(`  De SUCCESS, ${scaledThenSuccess}/${successGraduates.length} fueron escalados (correlacion escalada→exit learning)`);

  // ═══════════════════════════════════════════════════════════════════
  // 5. VEREDICTO
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══ VEREDICTO ═══\n');

  // Tendencia ROAS
  const dailySource = accountDaily.length > 0 ? accountDaily : [];
  let trendVerdict = 'NO HAY DATA SUFICIENTE';
  if (dailySource.length >= 7) {
    const first7 = dailySource.slice(0, Math.floor(dailySource.length/2));
    const last7 = dailySource.slice(Math.floor(dailySource.length/2));
    const avgFirst = first7.reduce((s,d) => s + (d.roas_7d || 0), 0) / first7.length;
    const avgLast = last7.reduce((s,d) => s + (d.roas_7d || 0), 0) / last7.length;
    const change = ((avgLast - avgFirst) / avgFirst) * 100;
    if (change > 5) trendVerdict = `MEJORANDO (+${change.toFixed(1)}%)`;
    else if (change < -5) trendVerdict = `DEGRADANDO (${change.toFixed(1)}%)`;
    else trendVerdict = `ESTABLE (${change.toFixed(1)}%)`;
  }
  console.log(`  Account ROAS trend (14d):       ${trendVerdict}`);
  console.log(`  Saturados (freq>3 o decline):   ${flagged}/${graduates.length} graduados`);
  console.log(`  Escaladas ciegas:               ${blindRepeats} (de ${okScales+blindRepeats} total medidas)`);
  console.log(`  Learning correlation:           ${scaledThenSuccess} de ${successGraduates.length} SUCCESS fueron escalados`);

  await mongoose.disconnect();
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
