require('dotenv').config();
const mongoose = require('mongoose');
const { MetaClient } = require('../src/meta/client');
const logger = require('../src/utils/logger');
const config = require('../config');

const DRY_RUN = !process.argv.includes('--execute');
const PHASE = parseInt(process.argv.find(a => a.startsWith('--phase='))?.split('=')[1] || '0');

// Configuracion del experimento CBO 3
const CBO3_CAMPAIGN_NAME = '[ARES] Medicion — Segunda Oportunidad';
const CBO3_BUDGET = 200;

const CBO1_CAMPAIGN_ID = '120240833848890259';
const CBO2_CAMPAIGN_ID = '120241047548570259';

// Criterios para candidatos a CBO 3:
// Real clones (no FT) starved en CBO 1 o CBO 2, <$10/7d, came from pipeline
const CBO3_CANDIDATE_CRITERIA = (clone) =>
  !clone.entity_name.includes('— FT') &&           // excluir FTs (criterio malo separado)
  (clone.spend_7d || 0) < 10 &&                    // starved
  [CBO1_CAMPAIGN_ID, CBO2_CAMPAIGN_ID].includes(clone.campaign_id);

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
      campaign_name: { $first: '$campaign_name' },
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
  const candidates = clones.filter(CBO3_CANDIDATE_CRITERIA);

  console.log('\nCandidatos a CBO 3 (' + candidates.length + '):');
  candidates.forEach(c => {
    const source = c.campaign_id === CBO1_CAMPAIGN_ID ? 'CBO1' : 'CBO2';
    console.log('  [' + source + '] "' + c.entity_name + '"  spend=$' + (c.spend_7d||0).toFixed(0) + '  purch=' + (c.purchases_7d||0));
  });

  console.log('\nPLAN DE EJECUCION (solo 2 fases — sin pausar nada):');
  console.log('  Phase 1 — Crear campana "' + CBO3_CAMPAIGN_NAME + '" con $' + CBO3_BUDGET + '/d');
  console.log('  Phase 2 — Duplicar los ' + candidates.length + ' candidatos a CBO 3');
  console.log('\nIMPORTANTE:');
  console.log('  - NO se pausa NADA en CBO 1 o CBO 2');
  console.log('  - Los originales quedan ACTIVOS (dormant) — por si Meta los despierta');
  console.log('  - Los duplicados en CBO 3 arrancan fresh learning con delivery garantizado');
  console.log('  - 11 FTs se quedan activos en CBO 1 (dormant, $0 cost)');
}

async function phase1CreateCBO3(meta) {
  banner('PHASE 1 — CREAR CBO 3' + (DRY_RUN ? ' [DRY RUN]' : ' [EXECUTE]'));

  // Verificar si ya existe
  const account = await meta.get('/' + config.meta.adAccountId + '/campaigns', {
    fields: 'id,name,daily_budget,status',
    limit: 100
  });
  const existing = (account.data || []).find(c => c.name === CBO3_CAMPAIGN_NAME);

  if (existing) {
    console.log('\n✓ Campana CBO 3 YA existe:');
    console.log('  ID: ' + existing.id);
    console.log('  Budget: $' + (existing.daily_budget ? parseInt(existing.daily_budget)/100 : '?') + '/d');
    console.log('  Status: ' + existing.status);
    console.log('\nPara continuar a Phase 2:');
    console.log('  node scripts/cbo3-create.js --phase=2 --cbo3-id=' + existing.id);
    return existing.id;
  }

  console.log('\nCampana CBO 3 NO existe. Se crearia con:');
  console.log('  Nombre: "' + CBO3_CAMPAIGN_NAME + '"');
  console.log('  Budget: $' + CBO3_BUDGET + '/d');
  console.log('  Objective: OUTCOME_SALES (match CBO 1, CBO 2)');
  console.log('  Status: ACTIVE');

  if (!DRY_RUN) {
    try {
      const result = await meta.createCampaign({
        name: CBO3_CAMPAIGN_NAME,
        objective: 'OUTCOME_SALES',
        status: 'ACTIVE',
        daily_budget: CBO3_BUDGET
      });
      console.log('\n✓ CREADA — ID: ' + result.id);
      console.log('\nGuarda este ID para Phase 2:');
      console.log('  node scripts/cbo3-create.js --phase=2 --execute --cbo3-id=' + result.id);
      return result.id;
    } catch (err) {
      console.log('\n✗ ERROR creando campana: ' + err.message);
      throw err;
    }
  } else {
    console.log('\n[DRY RUN] Para ejecutar: node scripts/cbo3-create.js --phase=1 --execute');
  }
}

async function phase2DuplicateToCBO3(meta) {
  banner('PHASE 2 — DUPLICAR STARVED CLONES A CBO 3' + (DRY_RUN ? ' [DRY RUN]' : ' [EXECUTE]'));

  const cbo3Id = process.argv.find(a => a.startsWith('--cbo3-id='))?.split('=')[1];
  if (!cbo3Id && !DRY_RUN) {
    console.log('\n✗ ERROR: --cbo3-id=<campaign_id> requerido para Phase 2 execute');
    console.log('  Corre Phase 1 primero para obtener el ID.');
    return;
  }

  const clones = await loadActiveClones();
  const candidates = clones.filter(CBO3_CANDIDATE_CRITERIA);

  console.log('\n' + candidates.length + ' clones a duplicar a CBO 3');
  console.log('Los originales en CBO 1 y CBO 2 NO se pausan (quedan dormant)\n');

  const results = [];
  for (const c of candidates) {
    const source = c.campaign_id === CBO1_CAMPAIGN_ID ? 'CBO1' : 'CBO2';
    console.log('\n  [' + source + '] "' + c.entity_name + '"  ID: ' + c.entity_id);

    if (DRY_RUN) {
      console.log('    [DRY] Paso 1: duplicate a CBO 3 (deep_copy: false, status: PAUSED inicial)');
      console.log('    [DRY] Paso 2: copiar best ad creative del original al clone');
      console.log('    [DRY] Paso 3: activar clone + ads');
      console.log('    [DRY] Paso 4: verificar ads ACTIVE en el clone');
      console.log('    [DRY] Original en ' + source + ' QUEDA ACTIVO (dormant)');
      continue;
    }

    try {
      // Paso 1: Duplicar ad set SIN ads (deep_copy: false)
      const dupName = c.entity_name.replace(/ — Clone \d+/, ' — UCI 1')
                                     .replace(' [Prometheus]', ' [Prometheus] — UCI');
      const dupResult = await meta.duplicateAdSet(c.entity_id, {
        campaign_id: cbo3Id,
        deep_copy: false,
        name: dupName,
        status: 'PAUSED'
      });
      if (!dupResult.success || !dupResult.new_adset_id) {
        throw new Error('duplicateAdSet failed: ' + JSON.stringify(dupResult));
      }
      console.log('    ✓ Duplicado: ' + dupResult.new_adset_id);

      // Paso 2: Copiar best ad creative
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

          try {
            const creativeDetail = await meta.get('/' + creativeId, { fields: 'object_story_spec' });
            if (JSON.stringify(creativeDetail).includes('191x100')) {
              console.log('    ⚠ Ad "' + ad.entity_name + '": creative con crop 191x100 deprecated — siguiente');
              continue;
            }
          } catch(_) {}

          await meta.createAd(dupResult.new_adset_id, creativeId, '[CBO3] ' + (ad.entity_name || 'Ad'), 'ACTIVE');
          console.log('    ✓ Ad copiado con creative ' + creativeId + ' (ROAS original: ' + (ad.metrics?.last_7d?.roas || 0).toFixed(2) + 'x)');
          adCopied = true;
          break;
        } catch (adErr) {
          console.log('    ⚠ Ad incompatible: ' + adErr.message.substring(0, 80) + ' — siguiente');
        }
      }
      if (!adCopied) {
        console.log('    ⚠ Ningun ad compatible — clone creado SIN ads. Requerira creative manual.');
      }

      // Paso 3: Activar el clone
      await meta.post('/' + dupResult.new_adset_id, { status: 'ACTIVE' });
      console.log('    ✓ Clone activado');

      // Verificar ads activos dentro del clone
      try {
        const cloneAds = await meta.get('/' + dupResult.new_adset_id + '/ads', { fields: 'id,name,status' });
        for (const ad of (cloneAds.data || [])) {
          if (ad.status !== 'ACTIVE') {
            try { await meta.post('/' + ad.id, { status: 'ACTIVE' }); } catch(_) {}
          }
        }
      } catch(_) {}

      // IMPORTANTE: NO pausar original (dejar dormant)
      console.log('    ℹ Original en ' + source + ' queda ACTIVO (dormant) — no pausamos');

      // Registrar en ActionLog
      const ActionLog = require('../src/db/models/ActionLog');
      await ActionLog.create({
        entity_type: 'adset',
        entity_id: c.entity_id,
        entity_name: c.entity_name,
        action: 'duplicate_adset',
        after_value: dupName,
        reasoning: 'CBO 3 experiment: starved clone from ' + source + ' duplicated for fresh learning measurement',
        confidence: 'high',
        agent_type: 'ares_agent',
        success: true,
        new_entity_id: dupResult.new_adset_id
      });

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
    console.log('\n✓ EXPERIMENTO INICIADO. Evaluar resultados en ~14 dias.');
  } else {
    console.log('\n[DRY RUN] Para ejecutar: node scripts/cbo3-create.js --phase=2 --execute --cbo3-id=' + (cbo3Id || '<CBO3_ID>'));
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
  else if (PHASE === 1) await phase1CreateCBO3(meta);
  else if (PHASE === 2) await phase2DuplicateToCBO3(meta);
  else {
    console.log('Uso:');
    console.log('  node scripts/cbo3-create.js --phase=0            (preview)');
    console.log('  node scripts/cbo3-create.js --phase=1            (dry-run crear CBO 3)');
    console.log('  node scripts/cbo3-create.js --phase=1 --execute  (crear CBO 3)');
    console.log('  node scripts/cbo3-create.js --phase=2 --cbo3-id=X            (dry-run duplicar)');
    console.log('  node scripts/cbo3-create.js --phase=2 --execute --cbo3-id=X  (duplicar)');
    console.log('\nNOTA: NO hay phase para pausar FTs — por design se quedan dormant.');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
