/**
 * Revisa una campaña CBO de Ares (default: el rescate del 20-may) en Meta:
 * estado, budget, adsets, y por cada adset cuántos ads están ACTIVE vs PAUSED
 * (para ver el bug de "creativos apagados") + métricas.
 *
 * Uso: MONGODB_URI=... node scripts/review-ares-rescue-cbo.js [campaignId]
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  if (!process.env.MONGODB_URI) { console.error('Falta MONGODB_URI'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 3 });

  const { getMetaClient } = require('../src/meta/client');
  const meta = getMetaClient();
  await meta._ensureToken();

  const CID = process.argv[2] || process.env.ARES_CBO_ID || '120243356468940259';

  // 1. Campaña
  const camp = await meta.get(`/${CID}`, {
    fields: 'name,status,effective_status,daily_budget,lifetime_budget,objective,created_time'
  });
  const budget = camp.daily_budget ? `$${(camp.daily_budget / 100).toFixed(2)}/d` : (camp.lifetime_budget ? `lifetime $${(camp.lifetime_budget/100).toFixed(2)}` : 'sin budget');
  console.log(`\n═══ ${camp.name} ═══`);
  console.log(`id=${CID} · status=${camp.status} (${camp.effective_status}) · ${budget} · ${camp.objective}`);
  console.log(`creada: ${camp.created_time}\n`);

  // 2. Métricas de la campaña (maximum)
  try {
    const ins = await meta.getInsights(CID, {
      fields: 'spend,impressions,clicks,ctr,cpc,inline_link_clicks,frequency,reach,actions',
      date_preset: 'maximum'
    });
    const r = Array.isArray(ins) ? ins[0] : (ins?.data?.[0] || ins);
    if (r) {
      console.log(`MÉTRICAS (lifetime): spend $${(+r.spend||0).toFixed(2)} · impr ${r.impressions||0} · clicks ${r.clicks||0} · CTR ${(+r.ctr||0).toFixed(2)}% · link clicks ${r.inline_link_clicks||0} · freq ${(+r.frequency||0).toFixed(2)} · reach ${r.reach||0}\n`);
    }
  } catch (e) { console.log(`(insights campaña: ${e.message})\n`); }

  // 3. Adsets + ads
  const adsets = await meta.getAdSets(CID, 'id,name,status,effective_status,daily_budget,learning_stage_info');
  console.log(`ADSETS: ${adsets.length}\n`);

  let totalAds = 0, totalActive = 0, totalPaused = 0, deadAdsets = 0;

  for (const a of adsets) {
    let ads = [];
    try {
      ads = await meta.getAds(a.id, 'id,name,status,effective_status');
    } catch (e) { /* ignore */ }
    const active = ads.filter(ad => ad.status === 'ACTIVE');
    const paused = ads.filter(ad => ad.status !== 'ACTIVE');
    totalAds += ads.length; totalActive += active.length; totalPaused += paused.length;

    const adsetActive = a.status === 'ACTIVE';
    const hasNoActiveAds = adsetActive && active.length === 0 && ads.length > 0;
    if (hasNoActiveAds) deadAdsets++;

    const flag = hasNoActiveAds ? '  ⚠ ACTIVE pero SIN ads activos (no entrega)' : '';
    console.log(`• [${a.status}] ${a.name}`);
    console.log(`    ${ads.length} ads · ${active.length} ACTIVE · ${paused.length} PAUSED${flag}`);
  }

  console.log(`\n═══ RESUMEN ═══`);
  console.log(`Adsets: ${adsets.length} · Ads totales: ${totalAds} (${totalActive} ACTIVE / ${totalPaused} PAUSED)`);
  console.log(`Adsets ACTIVE sin ningún ad activo (no entregan): ${deadAdsets}`);
  if (deadAdsets > 0) {
    console.log(`→ Estos son el bug de "creativos apagados". scripts/reactivate-rescue-ads.js los puede reactivar.`);
  }
  console.log('');

  await mongoose.disconnect();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
