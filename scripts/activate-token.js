/**
 * Activa el token nuevo (con page permissions) en la DB y prueba el camino
 * completo de comentarios de Hermes end-to-end.
 *
 * Uso: MONGODB_URI='...' META_NEW_TOKEN='...' node scripts/activate-token.js
 */
const mongoose = require('mongoose');

const SCOPES = [
  'pages_show_list', 'ads_management', 'ads_read', 'business_management',
  'pages_read_engagement', 'pages_read_user_content', 'pages_manage_engagement', 'public_profile'
];

async function main() {
  const TOKEN = process.env.META_NEW_TOKEN;
  if (!process.env.MONGODB_URI || !TOKEN) { console.error('Falta MONGODB_URI o META_NEW_TOKEN'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 3 });

  const col = mongoose.connection.db.collection('metatokens');
  const r = await col.updateOne(
    { is_active: true },
    { $set: { access_token: TOKEN, scopes: SCOPES, connection_status: 'connected', last_refreshed: new Date() } }
  );
  console.log(`✓ Token activo actualizado en DB (matched=${r.matchedCount}, modified=${r.modifiedCount})`);

  // Test end-to-end con el cliente real
  const { getMetaClient } = require('../src/meta/client');
  const meta = getMetaClient();
  await meta._ensureToken();

  const pageToken = await meta.getPageAccessToken();
  console.log(`✓ Page Access Token derivado (len ${pageToken.length})`);

  const HermesProposal = require('../src/db/models/HermesProposal');
  const live = await HermesProposal.findOne({ status: 'live', meta_ad_id: { $ne: null } })
    .sort({ meta_published_at: -1 }).lean();

  if (!live) {
    console.log('\n(sin ads live de Hermes para probar lectura — pero token + page token OK ✓)');
    await mongoose.disconnect();
    return;
  }

  const { story_id, comments } = await meta.getAdComments(live.meta_ad_id, { limit: 10 });
  console.log(`\n✓ Comentarios leídos del ad ${live.meta_ad_id} (story ${story_id}): ${comments.length}`);
  comments.slice(0, 6).forEach(c => console.log(`   · ${c.author_name}: "${(c.message || '').substring(0, 55)}"`));
  console.log('\n✅ LISTO — el sistema de comentarios puede operar con este token.\n');

  await mongoose.disconnect();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
