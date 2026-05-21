/**
 * Extiende el token de usuario a long-lived (fb_exchange_token) y lo guarda
 * activo en la DB. Después deriva el page token (permanente) y confirma.
 *
 * Secrets por env var — nunca hardcodeados.
 * Uso: MONGODB_URI='...' META_USER_TOKEN='...' META_APP_SECRET='...' node scripts/extend-token.js
 */
const mongoose = require('mongoose');
const axios = require('axios');

const GRAPH = 'https://graph.facebook.com/v21.0';
const SCOPES = [
  'pages_show_list', 'ads_management', 'ads_read', 'business_management',
  'pages_read_engagement', 'pages_read_user_content', 'pages_manage_engagement', 'public_profile'
];

async function main() {
  const TOKEN = process.env.META_USER_TOKEN;
  const SECRET = process.env.META_APP_SECRET;
  if (!process.env.MONGODB_URI || !TOKEN || !SECRET) {
    console.error('Falta MONGODB_URI / META_USER_TOKEN / META_APP_SECRET');
    process.exit(1);
  }

  // 1. APP_ID a partir del token
  const appRes = await axios.get(`${GRAPH}/app`, { params: { access_token: TOKEN, fields: 'id,name' } });
  const APP_ID = appRes.data.id;
  console.log(`App: ${appRes.data.name} (${APP_ID})`);

  // 2. Exchange a long-lived
  const ex = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: APP_ID,
      client_secret: SECRET,
      fb_exchange_token: TOKEN
    }
  });
  const longToken = ex.data.access_token;
  const expiresIn = ex.data.expires_in; // segundos; ausente o 0 = no expira
  const days = expiresIn ? Math.floor(expiresIn / 86400) : 'no expira';
  console.log(`✓ Long-lived obtenido (len ${longToken.length}) — expira en: ${days}${typeof days === 'number' ? ' días' : ''}`);

  // 3. Guardar activo en DB
  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 3 });
  const col = mongoose.connection.db.collection('metatokens');
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
  const r = await col.updateOne(
    { is_active: true },
    { $set: {
      access_token: longToken,
      token_type: 'long_lived',
      expires_at: expiresAt,
      scopes: SCOPES,
      connection_status: 'connected',
      last_refreshed: new Date()
    } }
  );
  console.log(`✓ Guardado en DB (modified=${r.modifiedCount}) — expires_at=${expiresAt ? expiresAt.toISOString() : 'null (no expira)'}`);

  // 4. Derivar page token (permanente) + confirmar
  const { getMetaClient } = require('../src/meta/client');
  const meta = getMetaClient();
  await meta._ensureToken();
  const pageToken = await meta.getPageAccessToken();
  console.log(`✓ Page Access Token derivado del long-lived (len ${pageToken.length}) — este NO expira`);

  console.log('\n✅ TOKEN LONG-LIVED ACTIVO Y FUNCIONANDO.\n');
  await mongoose.disconnect();
}

main().catch(e => {
  console.error('FATAL:', e.response?.data?.error?.message || e.message);
  process.exit(1);
});
