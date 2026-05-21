/**
 * Lee el MetaToken activo de la DB y reporta su estado (scopes, tipo, expiración).
 * Read-only. La URI se pasa por env var — no se hardcodea.
 *
 * Uso: MONGODB_URI='...' node scripts/check-meta-token-db.js
 */
const mongoose = require('mongoose');

const NEEDED = ['pages_show_list', 'pages_read_engagement', 'pages_manage_engagement'];

async function main() {
  if (!process.env.MONGODB_URI) { console.error('Falta MONGODB_URI'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 3 });

  const col = mongoose.connection.db.collection('metatokens');
  const active = await col.findOne({ is_active: true });
  const total = await col.countDocuments({});

  console.log(`\n═══ MetaToken en DB (${total} total) ═══\n`);
  if (!active) {
    console.log('✗ No hay token activo (is_active:true).');
    await mongoose.disconnect();
    return;
  }

  const tok = active.access_token || '';
  const daysLeft = active.expires_at
    ? Math.floor((new Date(active.expires_at) - new Date()) / 86400000)
    : null;

  console.log(`Usuario:        ${active.meta_user_name || '—'} (${active.meta_user_id || '—'})`);
  console.log(`Ad account:     ${active.ad_account_name || '—'} (${active.ad_account_id || '—'})`);
  console.log(`Token type:     ${active.token_type || '—'}`);
  console.log(`Token (prefijo):${tok.substring(0, 14)}…  (len ${tok.length})`);
  console.log(`Expira:         ${active.expires_at ? new Date(active.expires_at).toISOString() : 'nunca/null'}${daysLeft != null ? ` (${daysLeft} días)` : ''}`);
  console.log(`Conexión:       ${active.connection_status || '—'}`);
  console.log(`Último refresh: ${active.last_refreshed ? new Date(active.last_refreshed).toISOString() : '—'}`);

  const scopes = active.scopes || [];
  console.log(`\nScopes (${scopes.length}): ${scopes.join(', ') || '(ninguno guardado)'}`);
  console.log('\nPermisos de página necesarios para comentarios de Hermes:');
  let all = true;
  for (const s of NEEDED) {
    const has = scopes.includes(s);
    if (!has) all = false;
    console.log(`  ${has ? '✓' : '✗'} ${s}`);
  }
  console.log(`\n${all ? '✅ El token guardado YA tiene los permisos de página.' : '⚠ Faltan permisos de página en el token guardado.'}\n`);

  await mongoose.disconnect();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
