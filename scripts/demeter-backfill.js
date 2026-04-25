#!/usr/bin/env node
/**
 * Demeter backfill — corre snapshots para los últimos N días.
 *
 * Uso:
 *   node scripts/demeter-backfill.js              # default 60 días
 *   node scripts/demeter-backfill.js --days 30
 *   node scripts/demeter-backfill.js --days 14 --dry  # no escribe DB
 *
 * Requiere env:
 *   MONGODB_URI, META_ACCESS_TOKEN, META_AD_ACCOUNT_ID,
 *   SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_TOKEN
 *
 * Tiempo esperado: ~60s por día (Shopify API + Meta API). 60 días = ~1h.
 * Bloquea el script secuencialmente — no afecta el cron diario que corre
 * en otro proceso.
 */

const mongoose = require('mongoose');

(async () => {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) : 60;
  const dryRun = args.includes('--dry');

  if (!Number.isFinite(days) || days < 1 || days > 365) {
    console.error('--days debe ser 1-365');
    process.exit(1);
  }

  console.log(`══ Demeter Backfill ══`);
  console.log(`  días: ${days}`);
  console.log(`  dry-run: ${dryRun}`);

  // Validar env críticas
  const missing = ['MONGODB_URI', 'SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ADMIN_TOKEN', 'META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`✗ Env vars faltantes: ${missing.join(', ')}`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 5 });
  console.log('✓ Mongo conectado');

  // Verificar Shopify token con un ping
  const shopify = require('../src/integrations/shopify-client');
  const ping = await shopify.ping();
  if (!ping.ok) {
    console.error(`✗ Shopify ping falló: ${ping.error}`);
    process.exit(1);
  }
  console.log(`✓ Shopify OK: ${ping.shop} (plan: ${ping.plan})`);

  if (dryRun) {
    console.log('--dry: stop aquí, conexiones validadas');
    await mongoose.disconnect();
    process.exit(0);
  }

  const { backfillSnapshots } = require('../src/ai/agent/demeter-agent');
  const t0 = Date.now();
  const results = await backfillSnapshots(days);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const ok = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);

  console.log(`\n══ Backfill completado en ${elapsed}s ══`);
  console.log(`  ✓ ${ok}/${results.length} días procesados`);

  if (failed.length) {
    console.log(`\n✗ ${failed.length} fallaron:`);
    failed.forEach(f => console.log(`  ${f.date_et}: ${f.error}`));
  }

  // Stats summary últimos 7 días
  const last7 = results.slice(0, 7).filter(r => r.ok);
  if (last7.length > 0) {
    const avgRoas = last7.reduce((s, r) => s + (r.cash_roas || 0), 0) / last7.length;
    console.log(`\n  cash ROAS últimos 7d (avg): ${avgRoas.toFixed(2)}x`);
  }

  await mongoose.disconnect();
  console.log('✓ done');
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
