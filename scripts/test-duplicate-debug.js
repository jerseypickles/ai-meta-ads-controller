#!/usr/bin/env node
/**
 * Test de diagnóstico — reproduce el duplicate_adset que falló para [Ares] 11.
 *
 * Llama duplicateAdSet con los mismos params que usó el Ares Brain a la 1pm ET.
 * Captura el detalle real del error de Meta (code, subcode, message) que ahora
 * persiste con el fix del último commit.
 *
 * Uso: node scripts/test-duplicate-debug.js
 *
 * NO CAMBIA NADA SI FUNCIONA: si Meta acepta el call, el clon se crea PAUSED
 * (igual que en el flow real). Lo podés borrar después si no querés.
 */

const mongoose = require('mongoose');

(async () => {
  const SOURCE_ADSET = '120240863584860259';        // [Ares] 11 — Clone 1
  const TARGET_CAMPAIGN = '120241047548570259';     // [ARES] CBO 2 — Nuevos Ganadores

  const required = ['MONGODB_URI', 'META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID', 'APP_ID', 'APP_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('Env vars faltantes:', missing.join(', '));
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 5 });
  console.log('✓ Mongo conectado\n');

  // Validar fuente y target existen
  const MetricSnapshot = require('../src/db/models/MetricSnapshot');
  const src = await MetricSnapshot.findOne({ entity_type: 'adset', entity_id: SOURCE_ADSET }).sort({ snapshot_at: -1 }).lean();
  const tgt = await MetricSnapshot.findOne({ entity_type: 'campaign', entity_id: TARGET_CAMPAIGN }).sort({ snapshot_at: -1 }).lean();
  console.log(`Source adset: ${src?.entity_name} (status ${src?.status}, campaign ${src?.campaign_id})`);
  console.log(`Target CBO:   ${tgt?.entity_name} (status ${tgt?.status}, daily $${tgt?.daily_budget})\n`);

  // Llamar duplicateAdSet con los mismos params del flow real
  const { getMetaClient } = require('../src/meta/client');
  const meta = getMetaClient();

  console.log(`Llamando: duplicateAdSet(${SOURCE_ADSET}, { campaign_id: ${TARGET_CAMPAIGN}, deep_copy: true, status: PAUSED })\n`);

  try {
    const result = await meta.duplicateAdSet(SOURCE_ADSET, {
      campaign_id: TARGET_CAMPAIGN,
      deep_copy: true,
      name: '[Ares-Brain-Test] 11 — debug copy',
      status: 'PAUSED'
    });
    console.log('✓ ÉXITO INESPERADO:', result);
    console.log('\nNota: el clon quedó PAUSED. Si no lo querés, borralo manualmente en Meta.');
    console.log(`Clon nuevo: ${result.new_adset_id}`);
  } catch (err) {
    console.log('✗ FAIL (como esperábamos):');
    console.log(`Error message: ${err.message}\n`);

    // Si el error tiene response, mostrar cuerpo completo
    if (err.response?.data) {
      console.log('Response Meta API completa:');
      console.log(JSON.stringify(err.response.data, null, 2));
    }
    if (err.original?.response?.data) {
      console.log('\nResponse original:');
      console.log(JSON.stringify(err.original.response.data, null, 2));
    }
  }

  await mongoose.disconnect();
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
