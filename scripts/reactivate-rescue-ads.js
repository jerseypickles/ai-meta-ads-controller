/**
 * Reactiva ads PAUSED dentro de adsets duplicados por Ares Portfolio.
 *
 * Contexto (20-may-2026): el fallback de duplicateAdSet por Meta deprecation
 * (subcode 3858504, standard_enhancements) hardcodeaba PAUSED al re-link de
 * ads. Resultado: ~9 adsets ACTIVE en el CBO rescate con todos sus ads
 * apagados → no entregaban.
 *
 * Este script repara los adsets ya creados:
 *   1. Lee ActionLog de duplicate_adset por agent_type=ares_portfolio
 *      con detector=starved_winner_rescue en la ventana indicada
 *   2. Para cada new_adset_id, lista los ads PAUSED dentro
 *   3. Los reactiva vía Meta API
 *
 * Uso:
 *   MONGODB_URI=... META_ACCESS_TOKEN=... node scripts/reactivate-rescue-ads.js --dry-run
 *   MONGODB_URI=... META_ACCESS_TOKEN=... node scripts/reactivate-rescue-ads.js  (live)
 *
 * Flags:
 *   --dry-run     listar sin tocar Meta (default si no se pasa nada destructivo)
 *   --since=Nh    ventana hacia atrás (default 48h)
 *   --adset=ID    forzar un adset específico (skip ActionLog lookup)
 */

require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--live');
const sinceFlag = args.find(a => a.startsWith('--since='));
const SINCE_HOURS = sinceFlag ? parseInt(sinceFlag.split('=')[1], 10) : 48;
const adsetFlag = args.find(a => a.startsWith('--adset='));
const FORCED_ADSET = adsetFlag ? adsetFlag.split('=')[1] : null;

async function main() {
  const required = ['MONGODB_URI', 'META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID'];
  for (const k of required) {
    if (!process.env[k]) {
      console.error(`Falta env var: ${k}`);
      process.exit(1);
    }
  }

  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 5 });
  const { getMetaClient } = require('../src/meta/client');
  const meta = getMetaClient();
  const AL = mongoose.connection.db.collection('actionlogs');

  console.log(`\n═══ Reactivate Rescue Ads ${DRY_RUN ? '(DRY-RUN)' : '(LIVE)'} ═══`);
  console.log(`Ventana: últimas ${SINCE_HOURS}h${FORCED_ADSET ? ` | forzando adset=${FORCED_ADSET}` : ''}\n`);

  let adsetIds = [];

  if (FORCED_ADSET) {
    adsetIds = [{ new_adset_id: FORCED_ADSET, name: '(forced)', source_name: '(forced)' }];
  } else {
    const since = new Date(Date.now() - SINCE_HOURS * 3600000);
    const docs = await AL.find({
      agent_type: 'ares_portfolio',
      action: 'duplicate_adset',
      success: true,
      executed_at: { $gte: since },
      'metadata.detector': 'starved_winner_rescue',
      'metadata.new_adset_id': { $exists: true }
    }).sort({ executed_at: -1 }).toArray();

    adsetIds = docs.map(d => ({
      new_adset_id: d.metadata.new_adset_id,
      name: `${d.entity_name} → ${d.metadata.new_adset_id}`,
      source_name: d.entity_name,
      rescue_cbo_id: d.metadata.rescue_cbo_id,
      used_fallback: !!d.metadata.used_fallback_relink,
      executed_at: d.executed_at
    }));

    console.log(`Encontrados ${adsetIds.length} adsets duplicados por Ares Portfolio en la ventana.\n`);
  }

  if (adsetIds.length === 0) {
    console.log('Nada que hacer.');
    await mongoose.disconnect();
    return;
  }

  let totalReactivated = 0;
  let totalSkippedActive = 0;
  let totalFailed = 0;

  for (const item of adsetIds) {
    console.log(`\n─── Adset ${item.new_adset_id} (de "${item.source_name}") ───`);
    let ads;
    try {
      ads = await meta.getAds(item.new_adset_id, 'id,name,status');
    } catch (err) {
      console.log(`  ✗ getAds falló: ${err.message}`);
      totalFailed++;
      continue;
    }

    if (!ads || ads.length === 0) {
      console.log(`  (sin ads — adset vacío, skip)`);
      continue;
    }

    const paused = ads.filter(a => a.status !== 'ACTIVE');
    const active = ads.filter(a => a.status === 'ACTIVE');
    console.log(`  ${ads.length} ads total · ${active.length} ACTIVE · ${paused.length} no-ACTIVE`);

    if (paused.length === 0) {
      console.log(`  ✓ ya todos ACTIVE, skip`);
      continue;
    }

    for (const ad of paused) {
      const tag = `${ad.id} "${(ad.name || '').substring(0, 60)}" (status=${ad.status})`;
      if (DRY_RUN) {
        console.log(`  [dry-run] activaría: ${tag}`);
      } else {
        try {
          await meta.updateStatus(ad.id, 'ACTIVE');
          console.log(`  ✓ activado: ${tag}`);
          totalReactivated++;
        } catch (err) {
          console.log(`  ✗ fallo en ${ad.id}: ${err.message}`);
          totalFailed++;
        }
      }
    }
    totalSkippedActive += active.length;
  }

  console.log(`\n═══ Resumen ═══`);
  console.log(`Adsets revisados: ${adsetIds.length}`);
  if (DRY_RUN) {
    console.log(`Modo: DRY-RUN (nada se tocó). Re-ejecutá con --live para aplicar.`);
  } else {
    console.log(`Ads reactivados: ${totalReactivated}`);
    console.log(`Ads que ya estaban ACTIVE: ${totalSkippedActive}`);
    console.log(`Fallos: ${totalFailed}`);
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
