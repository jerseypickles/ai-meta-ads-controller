require('dotenv').config();
const mongoose = require('mongoose');
const { MetaClient } = require('../src/meta/client');
const logger = require('../src/utils/logger');
const config = require('../config');

const DRY_RUN = !process.argv.includes('--execute');
const PHASE = parseInt(process.argv.find(a => a.startsWith('--phase='))?.split('=')[1] || '0');

// Configuracion del experimento
const UCI_CAMPAIGN_NAME = '[ARES] UCI — Medicion';
const UCI_BUDGET = 150;

const CBO1_CAMPAIGN_ID = '120240833848890259';

// Criterios para FTs a pausar
const FT_PAUSE_CRITERIA = (clone) =>
  clone.entity_name.includes('— FT') &&
  (clone.spend_7d || 0) < 10 &&
  (clone.purchases_7d || 0) === 0;

// Criterios para real clones starved — candidatos a UCI
const UCI_CANDIDATE_CRITERIA = (clone) =>
  !clone.entity_name.includes('— FT') &&
  clone.entity_name.includes('— Clone') &&
  (clone.spend_7d || 0) < 10 &&
  clone.campaign_id === CBO1_CAMPAIGN_ID;

async function loadActiveClones() {
  const MS = mongoose.connection.db.collection('metricsnapshots');
  const clones = await MS.aggregate([
    { $match: { entity_type: 'adset', entity_name: { $regex: '\\[Ares\\]' } } },
    { $sort: { snapshot_at: -1 } },
    { $group: {
      _id: '$entity_id',
      entity_id: { $first: '$entity_id' },
      entity_name: { $first: '$entity_name' },
      campaign_id: { $first: '$campaign_id' },
      status: { $first: '$status' },
      spend_7d: { $first: '$metrics.last_7d.spend' },
      purchases_7d: { $first: '$metrics.last_7d.purchases' },
      roas_7d: { $first: '$metrics.last_7d.roas' }
    }},
    { $match: { status: 'ACTIVE' } }
  ]).toArray();
  return clones;
}

function banner(title) {
  console.log('\n' + '═'.repeat(72));
  console.log('  ' + title);
  console.log('═'.repeat(72));
}

async function phase0Preview() {
  banner('PHASE 0 — PREVIEW (read-only)');
  const clones = await loadActiveClones();

  const fts = clones.filter(FT_PAUSE_CRITERIA);
  const uciCands = clones.filter(UCI_CANDIDATE_CRITERIA);

  console.log('\nFTs a pausar (' + fts.length + '):');
  fts.forEach(c => console.log('  - "' + c.entity_name + '"  (spend 7d: $' + (c.spend_7d||0).toFixed(0) + ', purch: ' + (c.purchases_7d||0) + ')'));

  console.log('\nClones starved candidatos a UCI (' + uciCands.length + '):');
  uciCands.forEach(c => console.log('  - "' + c.entity_name + '"  (spend 7d: $' + (c.spend_7d||0).toFixed(0) + ', purch: ' + (c.purchases_7d||0) + ')'));

  console.log('\nPlan de ejecucion:');
  console.log('  Phase 1 — Pausar los ' + fts.length + ' FTs en CBO 1');
  console.log('  Phase 2 — Crear campana "' + UCI_CAMPAIGN_NAME + '" con budget $' + UCI_BUDGET + '/d');
  console.log('  Phase 3 — Duplicar los ' + uciCands.length + ' clones starved a UCI + pausar originales en CBO 1');
  console.log('\nCada fase se corre por separado con --phase=N --execute');
  console.log('Sin --execute, ningun cambio se aplica en Meta.');
}

async function phase1PauseFTs(meta) {
  banner('PHASE 1 — PAUSAR FTs' + (DRY_RUN ? ' [DRY RUN]' : ' [EXECUTE]'));
  const clones = await loadActiveClones();
  const fts = clones.filter(FT_PAUSE_CRITERIA);

  console.log('\n' + fts.length + ' FTs a pausar:');
  const results = [];
  for (const f of fts) {
    console.log('  [' + (DRY_RUN ? 'DRY' : 'EXEC') + '] pausando ' + f.entity_id + ' "' + f.entity_name + '"');
    if (!DRY_RUN) {
      try {
        await meta.updateStatus(f.entity_id, 'PAUSED');
        results.push({ id: f.entity_id, ok: true });
        console.log('         ✓ PAUSED');
      } catch (err) {
        results.push({ id: f.entity_id, ok: false, error: err.message });
        console.log('         ✗ FAILED: ' + err.message);
      }
    }
  }

  if (!DRY_RUN) {
    const ok = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok).length;
    console.log('\nResultado: ' + ok + ' pausados, ' + fail + ' fallos');
  } else {
    console.log('\n[DRY RUN] Para ejecutar: node scripts/uci-experiment.js --phase=1 --execute');
  }
}

async function phase2CreateUCI(meta) {
  banner('PHASE 2 — CREAR CBO UCI' + (DRY_RUN ? ' [DRY RUN]' : ' [EXECUTE]'));

  // Verificar si ya existe
  const account = await meta.get('/' + config.meta.adAccountId + '/campaigns', {
    fields: 'id,name,daily_budget,status',
    limit: 100
  });
  const existing = (account.data || []).find(c => c.name === UCI_CAMPAIGN_NAME);

  if (existing) {
    console.log('\n✓ Campana UCI ya existe:');
    console.log('  ID: ' + existing.id);
    console.log('  Budget: $' + (existing.daily_budget ? parseInt(existing.daily_budget)/100 : '?') + '/d');
    console.log('  Status: ' + existing.status);
    console.log('\nPara continuar a Phase 3, usa este ID: ' + existing.id);
    return existing.id;
  }

  console.log('\nCampana UCI NO existe. Se crearia con:');
  console.log('  Nombre: "' + UCI_CAMPAIGN_NAME + '"');
  console.log('  Budget: $' + UCI_BUDGET + '/d');
  console.log('  Objective: OUTCOME_SALES');
  console.log('  Status: ACTIVE');

  if (!DRY_RUN) {
    try {
      const result = await meta.createCampaign({
        name: UCI_CAMPAIGN_NAME,
        objective: 'OUTCOME_SALES',
        status: 'ACTIVE',
        daily_budget: UCI_BUDGET
      });
      console.log('\n✓ CREADA — ID: ' + result.id);
      console.log('\nGuarda este ID y usalo en Phase 3:');
      console.log('  node scripts/uci-experiment.js --phase=3 --execute --uci-id=' + result.id);
      return result.id;
    } catch (err) {
      console.log('\n✗ ERROR creando campana: ' + err.message);
      throw err;
    }
  } else {
    console.log('\n[DRY RUN] Para ejecutar: node scripts/uci-experiment.js --phase=2 --execute');
  }
}

async function phase3DuplicateToUCI(meta) {
  banner('PHASE 3 — DUPLICAR REAL CLONES A UCI' + (DRY_RUN ? ' [DRY RUN]' : ' [EXECUTE]'));

  const uciId = process.argv.find(a => a.startsWith('--uci-id='))?.split('=')[1];
  if (!uciId && !DRY_RUN) {
    console.log('\n✗ ERROR: --uci-id=<campaign_id> requerido para Phase 3 execute');
    console.log('  Corre Phase 2 primero o pasale el ID de la campana UCI.');
    return;
  }

  const clones = await loadActiveClones();
  const uciCands = clones.filter(UCI_CANDIDATE_CRITERIA);

  console.log('\n' + uciCands.length + ' clones a duplicar a UCI + pausar originales en CBO 1:');

  const results = [];
  for (const c of uciCands) {
    console.log('\n  "' + c.entity_name + '"  ID: ' + c.entity_id);

    if (DRY_RUN) {
      console.log('    [DRY] paso 1: duplicate a CBO UCI (deep_copy: false)');
      console.log('    [DRY] paso 2: copiar best ad creative al clone');
      console.log('    [DRY] paso 3: activar clone + ads');
      console.log('    [DRY] paso 4: pause original en CBO 1');
      continue;
    }

    try {
      // Paso 1: Duplicar ad set a UCI (sin ads, deep_copy: false)
      const dupName = c.entity_name.replace(' — Clone 1', ' — UCI 1');
      const dupResult = await meta.duplicateAdSet(c.entity_id, {
        campaign_id: uciId,
        deep_copy: false,
        name: dupName,
        status: 'PAUSED'
      });
      if (!dupResult.success || !dupResult.new_adset_id) {
        throw new Error('duplicateAdSet failed: ' + JSON.stringify(dupResult));
      }
      console.log('    ✓ Duplicado: ' + dupResult.new_adset_id);

      // Paso 2: Buscar el best ad del original y copiar creative
      const { getAdsForAdSet } = require('../src/db/queries');
      const originalAds = await getAdsForAdSet(c.entity_id);
      const activeAds = originalAds.filter(a => a.status === 'ACTIVE')
        .sort((a, b) => (b.metrics?.last_7d?.roas || 0) - (a.metrics?.last_7d?.roas || 0));

      let adCopied = false;
      for (const ad of activeAds) {
        try {
          const adData = await meta.get('/' + ad.entity_id, { fields: 'creative{id}' });
          const creativeId = adData.creative?.id;
          if (!creativeId) continue;

          // Verificar deprecated crops
          try {
            const creativeDetail = await meta.get('/' + creativeId, { fields: 'object_story_spec' });
            if (JSON.stringify(creativeDetail).includes('191x100')) continue;
          } catch(_) {}

          await meta.createAd(dupResult.new_adset_id, creativeId, '[UCI] ' + (ad.entity_name || 'Ad') + ' Copy', 'ACTIVE');
          console.log('    ✓ Ad copiado con creative ' + creativeId);
          adCopied = true;
          break;
        } catch (adErr) {
          console.log('    ⚠ Ad incompatible: ' + adErr.message + ' — probando siguiente');
        }
      }
      if (!adCopied) {
        console.log('    ⚠ Ningun ad compatible — clone quedara sin ads');
      }

      // Paso 3: Activar el clone
      await meta.post('/' + dupResult.new_adset_id, { status: 'ACTIVE' });
      console.log('    ✓ Clone activado');

      // Verificar ads dentro del clone activos
      const cloneAds = await meta.get('/' + dupResult.new_adset_id + '/ads', { fields: 'id,name,status' });
      for (const ad of (cloneAds.data || [])) {
        if (ad.status !== 'ACTIVE') {
          try { await meta.post('/' + ad.id, { status: 'ACTIVE' }); } catch(_) {}
        }
      }

      // Paso 4: Pausar original en CBO 1
      await meta.updateStatus(c.entity_id, 'PAUSED');
      console.log('    ✓ Original pausado en CBO 1');

      results.push({ id: c.entity_id, new_id: dupResult.new_adset_id, ok: true });
    } catch (err) {
      console.log('    ✗ FAILED: ' + err.message);
      results.push({ id: c.entity_id, ok: false, error: err.message });
    }
  }

  if (!DRY_RUN) {
    const ok = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok).length;
    console.log('\n' + '─'.repeat(50));
    console.log('Resultado: ' + ok + ' duplicados ok, ' + fail + ' fallos');
    if (fail > 0) {
      console.log('\nFallos:');
      results.filter(r => !r.ok).forEach(r => console.log('  - ' + r.id + ': ' + r.error));
    }
  } else {
    console.log('\n[DRY RUN] Para ejecutar: node scripts/uci-experiment.js --phase=3 --execute --uci-id=<UCI_CAMPAIGN_ID>');
  }
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 3 });
  const meta = new MetaClient();

  if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN MODE — sin cambios reales en Meta');
    console.log('    Para ejecutar en real: agregar --execute\n');
  } else {
    console.log('\n🔴 EXECUTE MODE — cambios REALES en Meta\n');
  }

  if (PHASE === 0) await phase0Preview();
  else if (PHASE === 1) await phase1PauseFTs(meta);
  else if (PHASE === 2) await phase2CreateUCI(meta);
  else if (PHASE === 3) await phase3DuplicateToUCI(meta);
  else {
    console.log('Uso:');
    console.log('  node scripts/uci-experiment.js --phase=0            (preview de todo)');
    console.log('  node scripts/uci-experiment.js --phase=1            (dry-run pausar FTs)');
    console.log('  node scripts/uci-experiment.js --phase=1 --execute  (ejecutar pausar FTs)');
    console.log('  node scripts/uci-experiment.js --phase=2            (dry-run crear UCI)');
    console.log('  node scripts/uci-experiment.js --phase=2 --execute  (ejecutar crear UCI)');
    console.log('  node scripts/uci-experiment.js --phase=3 --uci-id=X (dry-run duplicar)');
    console.log('  node scripts/uci-experiment.js --phase=3 --execute --uci-id=X');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
