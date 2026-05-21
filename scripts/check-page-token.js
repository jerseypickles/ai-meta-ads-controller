/**
 * Verifica si el token de Meta activo tiene lo necesario para el sistema de
 * comentarios de Hermes (leer + responder):
 *   1. Scopes del token (¿incluye pages_read_engagement / pages_manage_engagement / pages_show_list?)
 *   2. ¿Puede derivar el Page Access Token?
 *   3. ¿Puede leer comentarios de un ad live de Hermes?
 *
 * Uso:
 *   MONGODB_URI=... META_ACCESS_TOKEN=... node scripts/check-page-token.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const NEEDED = ['pages_show_list', 'pages_read_engagement', 'pages_manage_engagement'];

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('Falta MONGODB_URI');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 3 });

  const { getMetaClient } = require('../src/meta/client');
  const meta = getMetaClient();
  await meta._ensureToken();

  console.log('\n═══ Verificación token Meta para comentarios de Hermes ═══\n');

  // 1. Scopes
  const health = await meta.checkTokenHealth();
  if (!health.valid) {
    console.log(`✗ Token inválido: ${health.error || 'desconocido'}`);
    await mongoose.disconnect();
    return;
  }
  const scopes = health.scopes || [];
  console.log(`Token válido. Expira: ${health.expires} (${health.daysLeft} días)`);
  console.log(`Scopes actuales: ${scopes.join(', ')}\n`);

  console.log('Permisos de página necesarios:');
  let allPresent = true;
  for (const s of NEEDED) {
    const has = scopes.includes(s);
    if (!has) allPresent = false;
    console.log(`  ${has ? '✓' : '✗'} ${s}`);
  }
  console.log('');

  if (!allPresent) {
    console.log('⚠ Faltan permisos de página. El token NO sirve todavía para comentarios.');
    console.log('  → Agregar los scopes a REQUIRED_SCOPES (meta-auth.js) + reconectar Meta,');
    console.log('    o generar un Page Access Token desde Graph API Explorer para probar.\n');
    await mongoose.disconnect();
    return;
  }

  // 2. Page Access Token
  try {
    await meta.getPageAccessToken();
    console.log('✓ Page Access Token derivado correctamente');
  } catch (err) {
    console.log(`✗ No se pudo derivar el Page Access Token: ${err.message}`);
    await mongoose.disconnect();
    return;
  }

  // 3. Leer comentarios de un ad live de Hermes
  const HermesProposal = require('../src/db/models/HermesProposal');
  const live = await HermesProposal.findOne({ status: 'live', meta_ad_id: { $ne: null } })
    .sort({ meta_published_at: -1 }).lean();

  if (!live) {
    console.log('\n(no hay proposals live de Hermes para probar la lectura de comentarios)');
    console.log('Pero los permisos + page token están OK. ✓\n');
    await mongoose.disconnect();
    return;
  }

  try {
    const { story_id, comments } = await meta.getAdComments(live.meta_ad_id, { limit: 10 });
    console.log(`\n✓ Lectura de comentarios OK — ad ${live.meta_ad_id} (story ${story_id})`);
    console.log(`  ${comments.length} comentarios leídos. Muestra:`);
    for (const c of comments.slice(0, 5)) {
      console.log(`   · ${c.author_name}: "${(c.message || '').substring(0, 60)}"`);
    }
    console.log('\n✅ TODO LISTO — el sistema de comentarios puede operar.\n');
  } catch (err) {
    console.log(`\n✗ Falló la lectura de comentarios: ${err.message}\n`);
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
