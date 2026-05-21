/**
 * Reactiva los ads PAUSED dentro de adsets ACTIVE de una CBO — repara el bug
 * de "creativos apagados" (adset ACTIVE pero su ad quedó PAUSED por el fallback
 * de duplicateAdSet, así no entrega).
 *
 * Lee el token de Meta desde la DB (MetaToken activo) — no necesita token en env.
 *
 * Uso:
 *   MONGODB_URI=... node scripts/reactivate-cbo-ads.js [campaignId]            (dry-run)
 *   MONGODB_URI=... node scripts/reactivate-cbo-ads.js [campaignId] --live     (aplica)
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  if (!process.env.MONGODB_URI) { console.error('Falta MONGODB_URI'); process.exit(1); }
  const args = process.argv.slice(2);
  const LIVE = args.includes('--live');
  const CID = args.find(a => /^\d+$/.test(a)) || '120243356468940259';

  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 3 });
  const { getMetaClient } = require('../src/meta/client');
  const meta = getMetaClient();
  await meta._ensureToken();

  console.log(`\n═══ Reactivar ads PAUSED en CBO ${CID} ${LIVE ? '(LIVE)' : '(DRY-RUN)'} ═══\n`);

  const adsets = await meta.getAdSets(CID, 'id,name,status,effective_status');
  let toActivate = [], reactivated = 0, failed = 0;

  for (const a of adsets) {
    if (a.status !== 'ACTIVE') continue;  // solo adsets activos
    let ads = [];
    try { ads = await meta.getAds(a.id, 'id,name,status'); } catch (e) { continue; }
    const paused = ads.filter(ad => ad.status !== 'ACTIVE');
    const active = ads.filter(ad => ad.status === 'ACTIVE');
    // Solo nos interesan adsets ACTIVE que NO tienen ningún ad activo (muertos)
    if (active.length === 0 && paused.length > 0) {
      for (const ad of paused) toActivate.push({ adset: a.name, adId: ad.id, adName: ad.name });
    }
  }

  if (toActivate.length === 0) {
    console.log('No hay ads PAUSED en adsets ACTIVE muertos. Nada que hacer.\n');
    await mongoose.disconnect();
    return;
  }

  console.log(`${toActivate.length} ads a reactivar:\n`);
  for (const t of toActivate) {
    if (LIVE) {
      try {
        await meta.updateStatus(t.adId, 'ACTIVE');
        console.log(`  ✓ ACTIVADO: ${t.adId} en "${t.adset}"`);
        reactivated++;
      } catch (e) {
        console.log(`  ✗ FALLÓ ${t.adId}: ${e.message}`);
        failed++;
      }
    } else {
      console.log(`  [dry-run] activaría: ${t.adId} "${(t.adName||'').slice(0,40)}" en "${t.adset}"`);
    }
  }

  console.log(`\n═══ ${LIVE ? `Reactivados: ${reactivated} · Fallos: ${failed}` : `DRY-RUN: ${toActivate.length} ads se activarían. Re-corré con --live para aplicar.`} ═══\n`);
  await mongoose.disconnect();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
